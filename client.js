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
 * message delivery, removal, archive cleanup). This side only:
 * - rebuilds the command chip for a bare invocation, and
 * - opens the conversation named by the settled command result (or shows an
 *   inline notice when a brand-new conversation was moved in place).
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

        // The command only runs once the user submits the composed line; its
        // settled result then names the conversation to open.
        ctx.on('command/executed', (sessionId, name, result) => {
          if (name !== COMMAND) return
          if (!result || result.kind !== 'success') return
          const targetId = sessionIdFromText(result.text)
          if (targetId !== undefined) reveal(sessionId, targetId, result.text)
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
