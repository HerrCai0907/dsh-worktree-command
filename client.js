/**
 * Web half of the `/worktree` bundle.
 *
 * Interaction contract (matching the composer's ordinary leading-input
 * commands): pressing Enter or choosing the row from the `/` menu with Tab
 * never runs the command. It puts the `/worktree` command chip into the draft
 * and waits there; the user types the message that should start in the
 * worktree, and the next Enter submits `/worktree <message>`.
 *
 * The Host owns the operation itself (fork or adopt, worktree creation,
 * removal, archive cleanup). This side:
 * - rebuilds the command chip for a bare invocation,
 * - opens the conversation named by the settled command result (or shows an
 *   inline notice when a brand-new conversation was moved in place), and
 * - sends the composed message into that conversation through the ordinary
 *   prompt/queue pipeline, so it behaves like any other user message instead
 *   of being injected by the Host. Messages that carry attachments stay on the
 *   Host path because their draft records are released with the command.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-worktree-command',
  factory() {
    const COMMAND = 'worktree'
    const TOKEN = `/${COMMAND} `

    function errorText(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function sessionIdFromText(text) {
      if (typeof text !== 'string') return undefined
      const match = /(?:^|\n)\s*Session:\s*([A-Za-z0-9_-]+)\s*(?=\n|$)/u.exec(text)
      return match === null ? undefined : match[1]
    }

    function worktreePathFromText(text) {
      if (typeof text !== 'string') return undefined
      const match = /(?:^|\n)\s*Worktree:\s*(.+?)\s*(?=\n|$)/u.exec(text)
      return match === null ? undefined : match[1]
    }

    return {
      inject: ['commandUi', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        function notify(sessionId, level, text) {
          try {
            const actx = ctx.sessions.scope(sessionId)
            if (actx === undefined) return
            const conversation = actx.get('conversation')
            if (conversation === undefined || conversation.input === undefined) return
            conversation.input.for(actx).notify(level, text)
          } catch (error) {
            console.warn('[worktree-command] could not show a composer notice', error)
          }
        }

        function reveal(sessionId, targetId, text) {
          if (targetId === sessionId) {
            // A brand-new conversation is moved into the worktree in place, so
            // there is nothing to navigate to; make the change visible instead.
            const path = worktreePathFromText(text)
            notify(sessionId, 'info', path === undefined ? '已进入 worktree。' : `已进入 worktree：${path}`)
            return
          }
          try {
            ctx.uiWorkspace.openSession(targetId)
          } catch (error) {
            console.warn('[worktree-command] opening the worktree conversation failed', error)
            notify(sessionId, 'error', `已创建对话 ${targetId}，但无法自动打开：${errorText(error)}`)
          }
        }

        /**
         * Put the command chip back into the draft and hand the keyboard to the
         * composer. The claim restore is asynchronous, so an immediate edit
         * keeps the literal token, which Enter still adjudicates as the command.
         */
        function beginCommand(session) {
          const sessionId = session && (session.sessionId !== undefined ? session.sessionId : session.id)
          if (typeof sessionId !== 'string' || sessionId === '') return
          try {
            const actx = ctx.sessions.scope(sessionId)
            if (actx === undefined) return
            const conversation = actx.get('conversation')
            if (conversation === undefined || conversation.input === undefined) return
            const shell = conversation.input.for(actx)
            try {
              shell.setDraft({ text: TOKEN, references: [], command: { token: TOKEN } })
            } catch (error) {
              console.warn('[worktree-command] restoring the command claim failed; using literal text', error)
              shell.setDraft(TOKEN)
            }
            shell.focus()
          } catch (error) {
            console.warn('[worktree-command] restoring the command chip failed', error)
          }
        }

        /**
         * Read the message the user just submitted, before the command's
         * settle clears the draft. The chip token is stripped; the rest is
         * exactly the text `/worktree` was given.
         * @param sessionId - Session whose composer still holds the draft.
         * @returns the message text and its draft attachment ids, if readable.
         */
        function submittedMessage(sessionId) {
          try {
            const actx = ctx.sessions.scope(sessionId)
            if (actx === undefined) return undefined
            const conversation = actx.get('conversation')
            if (conversation === undefined || conversation.input === undefined) return undefined
            const state = conversation.input.for(actx).state.getSnapshot()
            if (state === undefined) return undefined
            const draft = typeof state.draft === 'string' ? state.draft : ''
            const token =
              state.command !== undefined && typeof state.command.token === 'string'
                ? state.command.token.trimEnd()
                : `/${COMMAND}`
            const trimmed = draft.trimStart()
            if (token === '' || !trimmed.startsWith(token)) return undefined
            const text = trimmed.slice(token.length).trim()
            const attachmentIds = Array.isArray(state.attachmentIds) ? [...state.attachmentIds] : []
            if (text === '' && attachmentIds.length === 0) return undefined
            return { text, attachmentIds }
          } catch (error) {
            console.warn('[worktree-command] reading the submitted message failed', error)
            return undefined
          }
        }

        /**
         * Send the composed message through the same prompt path as the
         * composer: a local submission echo, then a normal queue-mode prompt.
         * The new conversation may still be retaining, so wait for its scope.
         * @param targetId - conversation that should receive the message.
         * @param payload - message text and draft attachment ids.
         * @param fallbackId - Session that shows the notice when the target is
         *   not addressable.
         */
        async function sendMessage(targetId, payload, fallbackId) {
          const conversation = ctx.get('conversation')
          if (conversation === undefined || typeof conversation.sendSession !== 'function') return
          let actx
          for (let attempt = 0; attempt < 60; attempt += 1) {
            actx = ctx.sessions.scope(targetId)
            if (actx !== undefined) break
            await new Promise((resolve) => {
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
              else setTimeout(resolve, 16)
            })
          }
          if (actx === undefined) {
            notify(fallbackId, 'error', '无法找到新对话，消息没有发送。')
            return
          }
          const session = ctx.sessions.sessionOf(actx)
          if (session === undefined) return
          try {
            await conversation.sendSession(session, payload.text, payload.attachmentIds, 'queue', undefined, () => {})
          } catch (error) {
            console.warn('[worktree-command] sending the worktree message failed', error)
            notify(fallbackId, 'error', `消息发送失败：${errorText(error)}`)
          }
        }

        // The command only runs once the user submits the composed line; its
        // settled result then names the conversation to open and receive the
        // message through the normal prompt pipeline.
        ctx.on('command/executed', (sessionId, name, result) => {
          if (name !== COMMAND) return
          if (!result || result.kind !== 'success') return
          const targetId = sessionIdFromText(result.text)
          if (targetId === undefined) return
          const payload = submittedMessage(sessionId)
          reveal(sessionId, targetId, result.text)
          if (payload === undefined) {
            notify(sessionId, 'error', '无法读取要发送的消息，请在新对话中重新输入。')
            return
          }
          // Attachments are delivered by the Host (see the module comment).
          if (payload.attachmentIds.length === 0) void sendMessage(targetId, payload, sessionId)
        })

        ctx.effect(
          () =>
            ctx.commandUi.decorate({
              name: COMMAND,
              available: () => true,
              ui: {
                kind: 'action',
                run: (session) => {
                  beginCommand(session)
                },
              },
            }),
          'worktree-command: bare invocation',
        )
      },
    }
  },
})
