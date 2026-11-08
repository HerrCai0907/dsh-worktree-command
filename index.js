/**
 * Host half of the `/worktree` bundle.
 *
 * `/worktree`          fork the calling conversation, create a retained Git
 *                      worktree for it, and make the worktree the new
 *                      conversation's working directory.
 * `/worktree off`      remove the worktree linked to the calling conversation
 *                      and move that conversation back to the source checkout.
 * archive of a child   the same removal, driven by the workspace registry's
 *                      durable archive set (`domain/changed` on the workspace
 *                      global).
 *
 * The plugin deliberately imports nothing: every capability it needs arrives
 * through an injected Cordis service, so it keeps working when the profile
 * installs it from an arbitrary linked directory.
 */

export const inject = [
  'commands',
  'sessions',
  'sessionController',
  'workingDirectory',
  'fs',
  'subprocess',
  'sandbox',
  'sandboxPolicy',
  'agents',
  'storage',
]

const UNIT_SPEC = {
  name: 'dsh-worktree-links',
  version: 1,
  tables: ['links'],
  hasGlobal: false,
  layout: 'single',
}
const LINKS_TABLE = 'links'

/** Directories that must never leak a stale Git selector into a command. */
const GIT_ENV_DROP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

export function apply(ctx, config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const settings = {
    backend: typeof raw.backend === 'string' && raw.backend !== '' ? raw.backend : 'json',
    autoRemoveOnArchive: raw.autoRemoveOnArchive !== false,
    removeBranch: raw.removeBranch === true,
    gitCommand: typeof raw.gitCommand === 'string' && raw.gitCommand !== '' ? raw.gitCommand : 'git',
    gitTimeoutMs: positiveInteger(raw.gitTimeoutMs, 120000),
    maxOutputBytes: positiveInteger(raw.maxOutputBytes, 65536),
    idleWaitMs: positiveInteger(raw.idleWaitMs, 15000),
  }

  /** sessionId -> link record (authoritative copy for this process). */
  const links = new Map()
  /** Sessions whose archive cleanup already ran or is running in this process. */
  const archiveSeen = new Set()
  const archiveAttempted = new Set()
  const cleanupInflight = new Map()

  let storageUnit = null
  let storageOpening = null
  let linksLoaded = false
  let storageDisabled = false

  // ---------------------------------------------------------------- logging

  function warn(message, error) {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`[worktree-command] ${message}`)
        if (error !== undefined) ctx.logger.warn(error)
        return
      }
    } catch {
      // fall through to the console
    }
    if (error === undefined) console.warn(`[worktree-command] ${message}`)
    else console.warn(`[worktree-command] ${message}:`, error)
  }

  // ---------------------------------------------------------------- storage

  function backendByName(name) {
    try {
      const hub = ctx.storage
      if (!hub || !hub.backend || typeof hub.backend.get !== 'function') return undefined
      return hub.backend.get(name)
    } catch {
      return undefined
    }
  }

  async function openStorageUnit() {
    if (storageUnit) return storageUnit
    if (storageDisabled) throw new Error('worktree link storage is unavailable')
    if (!storageOpening) {
      storageOpening = (async () => {
        let backend = backendByName(settings.backend)
        if (!backend || !backend.kv) {
          const names = typeof ctx.storage.backend.names === 'function' ? ctx.storage.backend.names() : []
          for (const name of names) {
            const candidate = backendByName(name)
            if (candidate && candidate.kv) {
              backend = candidate
              break
            }
          }
        }
        if (!backend || !backend.kv) throw new Error('no storage backend exposes a kv facet')
        return backend.kv.open({ ...UNIT_SPEC })
      })()
        .then((unit) => {
          storageUnit = unit
          return unit
        })
        .catch((error) => {
          storageOpening = null
          storageDisabled = true
          throw error
        })
    }
    return storageOpening
  }

  async function ensureLinksLoaded() {
    if (linksLoaded || storageDisabled) return
    try {
      const unit = await openStorageUnit()
      const loaded = await unit.loadAll()
      const rows = loaded && loaded.tables ? loaded.tables[LINKS_TABLE] : undefined
      if (rows && typeof rows === 'object') {
        for (const [key, value] of Object.entries(rows)) {
          const link = normalizeLink(value)
          if (link === undefined) warn(`ignoring a malformed worktree link record: ${key}`)
          else links.set(key, link)
        }
      }
      linksLoaded = true
    } catch (error) {
      storageDisabled = true
      warn('worktree links cannot be loaded; continuing with in-memory records only', error)
    }
  }

  async function rememberLink(link) {
    links.set(link.sessionId, link)
    if (storageDisabled) return
    try {
      await ensureLinksLoaded()
      const unit = await openStorageUnit()
      await unit.putRecord(LINKS_TABLE, link.sessionId, link)
    } catch (error) {
      warn('saving a worktree link failed', error)
    }
  }

  async function forgetLink(sessionId) {
    links.delete(sessionId)
    if (storageDisabled) return
    try {
      await ensureLinksLoaded()
      const unit = await openStorageUnit()
      await unit.deleteRecord(LINKS_TABLE, sessionId)
    } catch (error) {
      warn('deleting a worktree link failed', error)
    }
  }

  ctx.effect(
    () => () => {
      const unit = storageUnit
      storageUnit = null
      storageOpening = null
      if (unit && typeof unit.close === 'function') Promise.resolve(unit.close()).catch(() => {})
    },
    'worktree-command: link storage',
  )

  // ------------------------------------------------------------------ git

  function gitEnvironment() {
    const env = { ...process.env }
    for (const key of GIT_ENV_DROP) delete env[key]
    env.GIT_OPTIONAL_LOCKS = '0'
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_PAGER = 'cat'
    env.GIT_NO_LAZY_FETCH = '1'
    env.GIT_LFS_SKIP_SMUDGE = '1'
    return env
  }

  async function policyFor(session, fallback) {
    let resolved
    try {
      resolved = ctx.sandboxPolicy.resolve(session ? { session } : {})
    } catch {
      resolved = undefined
    }
    // Cleanup passes the policy recorded when the worktree was created. That
    // policy is anchored at the source checkout, which is the writable root
    // that also contains the repository's shared Git directory. The current
    // session policy is anchored at the worktree itself and would fence the
    // Git metadata away, so the recorded policy wins unless the session now
    // runs unconfined.
    if (fallback && typeof fallback.mode === 'string' && fallback.mode !== 'read-only') {
      if (resolved && resolved.mode === 'danger-full-access') return resolved
      return {
        mode: fallback.mode,
        workspaceRoot: fallback.workspaceRoot || (resolved && resolved.workspaceRoot) || ctx.sandboxPolicy.workspaceRoot,
        additionalWritableRoots: fallback.additionalWritableRoots,
        sessionId: session ? session.id : undefined,
      }
    }
    if (!resolved) {
      return {
        mode: ctx.sandboxPolicy.defaultMode,
        workspaceRoot: ctx.sandboxPolicy.workspaceRoot,
        additionalWritableRoots: ctx.sandboxPolicy.additionalWritableRoots,
        sessionId: session ? session.id : undefined,
      }
    }
    return resolved
  }

  function collectedText(reader) {
    if (!reader || typeof reader.readFrom !== 'function') return ''
    try {
      return reader.readFrom(0).text
    } catch {
      return ''
    }
  }

  async function runGit(args, { cwd, policy, signal, timeoutMs }) {
    const executable = await ctx.subprocess.resolveExecutable(settings.gitCommand)
    const argv = [executable, ...args]
    let spawnArgv = argv
    if (policy && policy.mode !== 'danger-full-access') {
      const confined = await ctx.sandbox.confine(
        argv,
        {
          mode: policy.mode,
          workspaceRoot: policy.workspaceRoot,
          additionalWritableRoots: policy.additionalWritableRoots,
          sessionId: policy.sessionId,
        },
        signal,
      )
      spawnArgv = confined.argv
    }
    const handle = ctx.subprocess.spawn({
      argv: spawnArgv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: settings.maxOutputBytes },
        stderr: { maxBytes: settings.maxOutputBytes },
      },
      graceMs: 5000,
      signal,
      env: gitEnvironment(),
    })
    const timer = setTimeout(() => {
      try {
        handle.terminate()
      } catch {
        // the process may already be gone
      }
    }, timeoutMs !== undefined ? timeoutMs : settings.gitTimeoutMs)
    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
    }
    return {
      code: outcome.exitCode,
      signal: outcome.signal,
      stdout: collectedText(handle.collected && handle.collected.stdout),
      stderr: collectedText(handle.collected && handle.collected.stderr),
    }
  }

  /** `true` present, `false` absent, `undefined` unknown (an I/O or policy error). */
  async function pathExists(path, signal) {
    if (typeof path !== 'string' || path === '') return false
    try {
      const info = await ctx.fs.lstat(path, {}, signal)
      return info !== undefined
    } catch (error) {
      warn(`checking ${path} failed`, error)
      return undefined
    }
  }

  async function removeWorktree(link, { session, signal }) {
    if (!link || !link.repositoryRoot) return { ok: false, error: '链接记录缺少仓库根目录' }
    const repositoryPresent = await pathExists(link.repositoryRoot, signal)
    if (repositoryPresent === undefined) {
      return { ok: false, error: `无法检查源仓库目录：${link.repositoryRoot}` }
    }
    if (repositoryPresent === false) {
      return { ok: true, note: '源仓库已不存在，视为已清理' }
    }
    let policy
    try {
      policy = await policyFor(session, link.policy)
    } catch (error) {
      return { ok: false, error: `无法确定文件权限策略：${messageOf(error)}` }
    }
    const present = await pathExists(link.path, signal)
    if (present === undefined) {
      return { ok: false, error: `无法检查 worktree 目录：${link.path}` }
    }
    if (present) {
      let result
      try {
        result = await runGit(['worktree', 'remove', '--force', link.path], {
          cwd: link.repositoryRoot,
          policy,
          signal,
        })
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
      if (result.code !== 0) {
        try {
          await runGit(['worktree', 'unlock', link.path], { cwd: link.repositoryRoot, policy, signal })
        } catch {
          // unlock is best effort
        }
        try {
          result = await runGit(['worktree', 'remove', '--force', '--force', link.path], {
            cwd: link.repositoryRoot,
            policy,
            signal,
          })
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }
      if (result.code !== 0) {
        return {
          ok: false,
          error: result.stderr.trim() || result.stdout.trim() || `git worktree remove exited with ${String(result.code)}`,
        }
      }
    } else {
      try {
        await runGit(['worktree', 'prune'], { cwd: link.repositoryRoot, policy, signal })
      } catch (error) {
        warn('git worktree prune failed', error)
      }
    }
    if (settings.removeBranch && link.branch) {
      try {
        const deleted = await runGit(['branch', '-D', link.branch], { cwd: link.repositoryRoot, policy, signal })
        if (deleted.code !== 0 && !/not found/iu.test(deleted.stderr)) {
          warn(`deleting branch ${link.branch} failed: ${deleted.stderr.trim()}`)
        }
      } catch (error) {
        warn(`deleting branch ${link.branch} failed`, error)
      }
    }
    return { ok: true }
  }

  // --------------------------------------------------------------- commands

  async function preflightRepository(agent, signal) {
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) return { ok: false, error: '找不到当前对话的 Session。' }
    let cwd
    try {
      cwd = ctx.workingDirectory.get(session)
    } catch (error) {
      return { ok: false, error: `无法读取当前工作目录：${messageOf(error)}` }
    }
    let policy
    try {
      policy = await policyFor(session, undefined)
    } catch (error) {
      return { ok: false, error: `无法确定文件权限策略：${messageOf(error)}` }
    }
    try {
      const probe = await runGit(['rev-parse', '--show-toplevel'], { cwd, policy, signal })
      if (probe.code !== 0) {
        return { ok: false, error: `当前目录不是 Git 仓库，无法创建 worktree：${cwd}` }
      }
    } catch (error) {
      return { ok: false, error: `无法执行 git（${settings.gitCommand}）：${messageOf(error)}` }
    }
    return { ok: true, cwd, policy }
  }

  function turnBoundary(session) {
    try {
      const boundary = ctx.agents.turnBoundaryOf(session)
      return boundary && typeof boundary.lastTurn === 'number' ? boundary : undefined
    } catch {
      return undefined
    }
  }

  function randomHex(length) {
    let value = ''
    while (value.length < length) value += Math.random().toString(16).slice(2)
    return value.slice(0, length)
  }

  /** Mirror the worktree runtime's `dsh-<uuid8>-<rand4>` naming. */
  function generatedWorktreeName(sessionId) {
    const match = /([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-/.exec(String(sessionId))
    const prefix = match === null ? randomHex(8) : match[1].toLowerCase()
    return `dsh-${prefix}-${randomHex(4)}`
  }

  function joinPath(first, ...rest) {
    const parts = [String(first).replace(/[\\/]+$/u, '')]
    for (const part of rest) {
      const text = String(part).replace(/^[\\/]+|[\\/]+$/gu, '')
      if (text !== '') parts.push(text)
    }
    return parts.join('/')
  }

  async function gitStdout(args, options) {
    const result = await runGit(args, options)
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} exited with ${String(result.code)}`,
      )
    }
    return result.stdout.trim()
  }

  async function ensurePoolIgnore(repositoryRoot, policy, signal) {
    const ignorePath = joinPath(repositoryRoot, '.agents', 'worktrees', '.gitignore')
    const present = await pathExists(ignorePath, signal)
    if (present !== false) return
    try {
      const target = await ctx.fs.resolve(ignorePath, { cwd: repositoryRoot, signal })
      await ctx.fs.writeText(target, '*\n', { kind: 'createIfAbsent' }, signal, policy)
    } catch (error) {
      warn('writing the worktree pool ignore file failed', error)
    }
  }

  /**
   * Create the checkout for `targetAgent` and make it that agent's working
   * directory. Uses the shipped worktree runtime when it is mounted; otherwise
   * runs the same Git steps itself so the command has no feature dependency.
   */
  async function createWorktreeFor(targetAgent, targetSession, preflight, signal) {
    const native = ctx.get('worktrees')
    if (native && typeof native.create === 'function') {
      const created = await native.create(targetAgent, {}, signal)
      return {
        path: created.path,
        branch: created.branch,
        baseCommit: created.baseCommit,
        repositoryRoot: created.repositoryRoot,
      }
    }

    const policy = preflight.policy
    const repositoryRoot = await gitStdout(['rev-parse', '--show-toplevel'], {
      cwd: preflight.cwd,
      policy,
      signal,
    })
    let baseCommit
    try {
      baseCommit = await gitStdout(['rev-parse', 'HEAD'], { cwd: repositoryRoot, policy, signal })
    } catch (error) {
      throw new Error(`无法解析 HEAD（仓库可能还没有提交）：${messageOf(error)}`)
    }
    if (baseCommit === '') throw new Error('仓库还没有提交，无法创建 worktree。')

    let name = ''
    let path = ''
    let added
    for (let attempt = 0; attempt < 3; attempt += 1) {
      name = generatedWorktreeName(String(targetAgent.id))
      path = joinPath(repositoryRoot, '.agents', 'worktrees', name)
      added = await runGit(
        [
          '-c', 'filter.lfs.process=',
          '-c', 'filter.lfs.smudge=',
          '-c', 'filter.lfs.required=false',
          '-c', 'core.fsmonitor=false',
          'worktree', 'add', '-b', name, path, baseCommit,
        ],
        { cwd: repositoryRoot, policy, signal },
      )
      if (added.code === 0) break
      const detail = `${added.stderr}\n${added.stdout}`
      if (!/already exists|already checked out|is a working tree/iu.test(detail)) break
    }
    if (!added || added.code !== 0) {
      throw new Error(
        (added && (added.stderr.trim() || added.stdout.trim())) || 'git worktree add 失败',
      )
    }

    await ensurePoolIgnore(repositoryRoot, policy, signal)
    try {
      await ctx.workingDirectory.set(targetAgent, path, signal)
    } catch (error) {
      // Never leave a checkout this conversation cannot enter.
      await removeWorktree(
        {
          sessionId: String(targetAgent.id),
          path,
          branch: name,
          baseCommit,
          repositoryRoot,
          policy: { mode: policy.mode, workspaceRoot: policy.workspaceRoot, additionalWritableRoots: policy.additionalWritableRoots },
        },
        { session: targetSession, signal: undefined },
      ).catch(() => {})
      throw new Error(`worktree 已创建，但无法把它设为该对话的工作目录：${messageOf(error)}`)
    }
    return { path, branch: name, baseCommit, repositoryRoot }
  }

  function newMessageId() {
    try {
      return globalThis.crypto.randomUUID()
    } catch {
      return `msg-${Date.now().toString(16)}-${randomHex(16)}`
    }
  }

  /**
   * Build a complete `UserMessage`: the inbox takes the message verbatim, so
   * `role` and a stable `id` must be present or the provider request carries a
   * role-less message and is rejected.
   */
  function createUserMessage(input) {
    const clone = structuredClone(input)
    const message = { ...clone, role: 'user', id: newMessageId() }
    const freeze = (value) => {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const key of Object.keys(value)) freeze(value[key])
      }
      return value
    }
    return freeze(message)
  }

  async function deliverFirstMessage(targetAgent, targetSession, message, attachments) {
    const content = []
    if (typeof message === 'string' && message !== '') content.push({ type: 'text', text: message })
    for (const block of attachments) content.push(block)
    if (content.length === 0) return false
    if (!targetAgent || typeof targetAgent.followup !== 'function') {
      throw new Error('该对话的 Agent 不支持接收消息')
    }
    targetAgent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    if (targetSession !== undefined) {
      try {
        await ctx.sessions.flush(targetSession)
      } catch (error) {
        warn('flushing the delivered message failed', error)
      }
    }
    return true
  }

  async function createFlow(invocation, message) {
    const signal = invocation.signal
    const preflight = await preflightRepository(invocation.agent, signal)
    if (!preflight.ok) return { kind: 'error', text: preflight.error }
    await ensureLinksLoaded()

    const parentSession = ctx.sessions.get(invocation.agent.id)
    const boundary = parentSession === undefined ? undefined : turnBoundary(parentSession)
    // A brand-new conversation has nothing to fork. Move that very Session into
    // the worktree instead, so its first message starts there.
    const blankSource = boundary !== undefined && boundary.lastTurn === 0

    let targetAgent
    let targetSession
    let forked = false
    if (blankSource) {
      targetAgent = invocation.agent
      targetSession = parentSession
    } else {
      let forkedValue
      try {
        forkedValue = await ctx.sessionController.fork({ sessionId: invocation.agent.id })
      } catch (error) {
        return { kind: 'error', text: `无法 fork 当前对话：${messageOf(error)}` }
      }
      const childId = forkedValue && forkedValue.sessionId
      if (typeof childId !== 'string' || childId === '') {
        return { kind: 'error', text: 'fork 当前对话后没有拿到新的 Session id。' }
      }
      let resolved
      try {
        resolved = await ctx.sessionController.resolveAgent(childId)
      } catch (error) {
        return { kind: 'error', text: `已 fork 出对话 ${childId}，但无法打开它：${messageOf(error)}` }
      }
      if (!resolved || resolved.error) {
        const code = resolved && resolved.error ? resolved.error.code : 'unknown'
        return { kind: 'error', text: `已 fork 出对话 ${childId}，但无法打开它：${code}` }
      }
      targetAgent = resolved.agent
      targetSession = ctx.sessions.get(childId)
      forked = true
    }

    let created
    try {
      created = await createWorktreeFor(targetAgent, targetSession, preflight, signal)
    } catch (error) {
      const prefix = forked ? `已 fork 出对话 ${targetAgent.id}，但` : ''
      return { kind: 'error', text: `${prefix}创建 worktree 失败：${messageOf(error)}` }
    }

    const policy = preflight.policy
    const link = {
      sessionId: String(targetAgent.id),
      path: created.path,
      branch: created.branch,
      baseCommit: created.baseCommit,
      repositoryRoot: created.repositoryRoot,
      createdAt: new Date().toISOString(),
      policy: policy
        ? {
            mode: policy.mode,
            workspaceRoot: policy.workspaceRoot,
            additionalWritableRoots: policy.additionalWritableRoots,
          }
        : undefined,
    }
    await rememberLink(link)

    let delivered = false
    let deliveryError = ''
    const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
    if (message !== '' || attachments.length > 0) {
      try {
        delivered = await deliverFirstMessage(targetAgent, targetSession, message, attachments)
      } catch (error) {
        deliveryError = messageOf(error)
      }
    }

    const short = typeof link.baseCommit === 'string' ? link.baseCommit.slice(0, 10) : ''
    return {
      kind: 'success',
      text: [
        blankSource
          ? '当前会话还没有对话历史，已直接把它的工作目录切换到新 worktree。'
          : '已 fork 当前对话，并让新对话在这个 worktree 中工作。',
        `路径：${link.path}`,
        `分支：${link.branch}${short === '' ? '' : `（基于 ${short}）`}`,
        delivered ? '随命令发送的消息已进入该对话，会直接在 worktree 中开始处理。' : '',
        deliveryError === '' ? '' : `消息发送失败：${deliveryError}`,
        '删除方式：在该对话中执行 /worktree off，或归档该对话。',
        '',
        `Worktree: ${link.path}`,
        `Session: ${targetAgent.id}`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    }
  }

  async function deriveLink(sessionId, signal) {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    let directory
    try {
      directory = ctx.workingDirectory.get(session)
    } catch {
      return undefined
    }
    if (typeof directory !== 'string') return undefined
    const poolMatch = /(^|[\\/])\.agents[\\/]worktrees[\\/][^\\/]+[\\/]?$/u.exec(directory)
    if (poolMatch === null) return undefined
    const repositoryRoot = directory.slice(0, poolMatch.index) || undefined
    if (repositoryRoot === undefined) return undefined
    let policy
    try {
      policy = await policyFor(session, undefined)
    } catch {
      return undefined
    }
    let branch = ''
    try {
      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: directory,
        policy,
        signal,
      })
      if (branchResult.code === 0) branch = branchResult.stdout.trim()
    } catch {
      return undefined
    }
    return {
      sessionId,
      path: directory,
      branch,
      baseCommit: '',
      repositoryRoot,
      createdAt: new Date().toISOString(),
      // Anchor the cleanup grant at the source checkout, not at the worktree:
      // `git worktree remove` also writes the shared Git directory there.
      policy: {
        mode: policy.mode,
        workspaceRoot: repositoryRoot,
        additionalWritableRoots: policy.additionalWritableRoots,
      },
      derived: true,
    }
  }

  async function offFlow(invocation) {
    const agent = invocation.agent
    if (agent && agent.status === 'running') {
      return { kind: 'error', text: '当前回合仍在运行，请先停止当前回合，再执行 /worktree off。' }
    }
    await ensureLinksLoaded()
    let link = links.get(agent.id)
    if (link === undefined) link = await deriveLink(agent.id, invocation.signal)
    if (link === undefined) {
      return { kind: 'error', text: '这个对话没有由 /worktree 创建的 worktree。' }
    }
    const session = ctx.sessions.get(agent.id)
    const removed = await removeWorktree(link, { session, signal: invocation.signal })
    if (!removed.ok) return { kind: 'error', text: `删除 worktree 失败：${removed.error}` }
    await forgetLink(agent.id)

    let moved = false
    if (session !== undefined && typeof link.repositoryRoot === 'string') {
      try {
        await ctx.workingDirectory.set(agent, link.repositoryRoot)
        moved = true
      } catch (error) {
        warn('moving the conversation back to the source checkout failed', error)
      }
    }
    return {
      kind: 'success',
      text: [
        'worktree 已删除。',
        `路径：${link.path}`,
        settings.removeBranch ? '分支也已删除。' : `分支 ${link.branch || '(unknown)'} 已保留。`,
        moved
          ? `对话工作目录已切回：${link.repositoryRoot}`
          : '对话工作目录将在下一次请求时自动回到源项目。',
      ].join('\n'),
    }
  }

  async function handleCommand(invocation) {
    const input = String(invocation.rawInput === undefined ? '' : invocation.rawInput).trim()
    try {
      if (input.toLowerCase() === 'off') {
        if (Array.isArray(invocation.attachments) && invocation.attachments.length > 0) {
          return { kind: 'error', text: '/worktree off 不接受附件。' }
        }
        return await offFlow(invocation)
      }
      return await createFlow(invocation, input)
    } catch (error) {
      return { kind: 'error', text: `worktree 操作失败：${messageOf(error)}` }
    }
  }

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'worktree',
        description:
          'Create a Git worktree and continue there; a following message becomes its first prompt, "off" removes it.',
        input: { hint: 'off | <message>', attachments: true },
        handler: (invocation) => handleCommand(invocation),
      }),
    'worktree-command: /worktree command',
  )

  // ------------------------------------------------------- archive cleanup

  async function cleanupArchived(sessionId) {
    await ensureLinksLoaded()
    const link = links.get(sessionId)
    if (link === undefined) return
    const running = cleanupInflight.get(sessionId)
    if (running !== undefined) {
      await running
      return
    }
    const task = (async () => {
      const agent = ctx.agents.get(sessionId)
      if (agent && agent.status === 'running' && typeof agent.whenIdle === 'function') {
        try {
          await Promise.race([
            Promise.resolve(agent.whenIdle()).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, settings.idleWaitMs)),
          ])
        } catch {
          // cleanup proceeds on the bounded wait
        }
      }
      const session = ctx.sessions.get(sessionId)
      const result = await removeWorktree(link, { session, signal: undefined })
      if (result.ok) {
        await forgetLink(sessionId)
      } else {
        warn(`archiving ${sessionId} left its worktree in place: ${result.error}`)
      }
    })()
      .catch((error) => warn(`archive cleanup for ${sessionId} failed`, error))
      .finally(() => cleanupInflight.delete(sessionId))
    cleanupInflight.set(sessionId, task)
    await task
  }

  ctx.on('domain/changed', (change) => {
    try {
      if (!change || change.domain !== 'workspace' || change.table !== '' || change.key !== '') return
      if (change.operation !== 'put') return
      const value = change.value
      if (!value || !Array.isArray(value.archivedSessionIds)) return
      const archived = new Set(value.archivedSessionIds.map((id) => String(id)))
      for (const id of [...archiveSeen]) {
        if (!archived.has(id)) {
          archiveSeen.delete(id)
          archiveAttempted.delete(id)
        }
      }
      for (const id of archived) {
        if (archiveSeen.has(id)) continue
        archiveSeen.add(id)
        if (!settings.autoRemoveOnArchive || archiveAttempted.has(id)) continue
        archiveAttempted.add(id)
        if (!links.has(id)) {
          void ensureLinksLoaded().then(() => {
            if (links.has(id)) void cleanupArchived(id)
          })
          continue
        }
        void cleanupArchived(id)
      }
    } catch (error) {
      warn('reading a workspace archive change failed', error)
    }
  })

  async function sweepArchivedLinks() {
    await ensureLinksLoaded()
    let archivedIds
    try {
      const domain = ctx.get('storageDomain')
      const workspace = domain && typeof domain.get === 'function' ? domain.get('workspace') : undefined
      const global = workspace && workspace.global
      const value = global && typeof global.get === 'function' ? global.get() : undefined
      if (value && Array.isArray(value.archivedSessionIds)) {
        archivedIds = value.archivedSessionIds.map((id) => String(id))
      }
    } catch (error) {
      warn('reading the current archive set failed', error)
    }
    if (archivedIds === undefined) return
    for (const id of archivedIds) {
      archiveSeen.add(id)
      if (!settings.autoRemoveOnArchive || archiveAttempted.has(id)) continue
      archiveAttempted.add(id)
      if (links.has(id)) void cleanupArchived(id)
    }
  }

  void (async () => {
    await ensureLinksLoaded()
    await sweepArchivedLinks()
  })().catch((error) => warn('startup worktree sweep failed', error))
}

function positiveInteger(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function normalizeLink(value) {
  if (!value || typeof value !== 'object') return undefined
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  const path = typeof value.path === 'string' ? value.path : ''
  const repositoryRoot = typeof value.repositoryRoot === 'string' ? value.repositoryRoot : ''
  if (sessionId === '' || path === '' || repositoryRoot === '') return undefined
  const link = {
    sessionId,
    path,
    branch: typeof value.branch === 'string' ? value.branch : '',
    baseCommit: typeof value.baseCommit === 'string' ? value.baseCommit : '',
    repositoryRoot,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  }
  if (value.policy && typeof value.policy === 'object' && typeof value.policy.mode === 'string') {
    link.policy = {
      mode: value.policy.mode,
      workspaceRoot:
        typeof value.policy.workspaceRoot === 'string' ? value.policy.workspaceRoot : repositoryRoot,
      additionalWritableRoots: Array.isArray(value.policy.additionalWritableRoots)
        ? value.policy.additionalWritableRoots.filter((entry) => typeof entry === 'string')
        : undefined,
    }
  }
  return link
}

function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}
