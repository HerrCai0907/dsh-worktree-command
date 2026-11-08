# /worktree — continue a conversation in a Git worktree

A DSH bundle that adds one slash command to the Web GUI:

| Input | Result |
|---|---|
| `/worktree` + Enter, or picking the row with Tab | Does **not** run anything. The composer keeps the `/worktree` command chip (with the `off | <message>` hint) and waits for the message. |
| `/worktree <message>` + Enter | Forks a conversation that already has turns (or, for a brand-new conversation, uses that conversation), creates a new branch + checkout under `<repo>/.agents/worktrees/`, makes the checkout the conversation's working directory, starts the message there, and opens the conversation. |
| `/worktree off` + Enter | Removes the worktree linked to the current conversation and moves the conversation back to the source checkout. |
| *(archive the conversation)* | The worktree linked to that conversation is removed automatically. |

A bare `/worktree` is an ordinary leading-input command: Enter or Tab only claims the token, and the next Enter submits the composed line. Only a line with arguments (`<message>` or `off`) executes.

The archive rule also covers the "stop activity and archive" path, and it keeps working after a Host restart because links are persisted.

## Install

Install the package directory as a bundle in the current profile (Plugins → install from a local package, or `plugin_manager` `install_bundle` with this absolute directory). Refresh the Web page once afterwards so the browser half loads.

The package directory must stay where it is: a local bundle is installed as a link to this directory.

## How it works

- **Fork** — `ctx.sessionController.fork()` creates the durable child conversation; the latest completed turn is selected, exactly like the sidebar's Fork action. A conversation with no turn yet has nothing to fork, so the command simply moves that conversation into the worktree instead of creating another blank one.
- **Worktree** — the shipped worktree runtime (`ctx.worktrees.create`) is used when it is mounted; otherwise the plugin runs the same Git steps through the sandboxed subprocess provider: `rev-parse --show-toplevel`, `rev-parse HEAD`, then `git worktree add -b dsh-<uuid8>-<rand4> <repo>/.agents/worktrees/<name> <commit>`. It writes the pool's `*` ignore file when missing, and records the directory as the conversation's working directory. Uncommitted source files stay in the source checkout. No "Change requests & worktrees" feature bundle is required.
- **Message** — text after `/worktree` is delivered to the target Agent as an ordinary user message (`agent.followup`) after its directory change is committed, so the model's first request already runs in the worktree. Composer attachments are forwarded with it.
- **Queue** — human messages still queued in the source conversation when the fork happens are moved into the new conversation before that message is delivered, so input typed while the source was still working keeps running (and stays visible in the queue dock) where the user now is. A message the source already claimed stays there. Only human prompts move: goal rounds, scheduled deliveries, and subagent reports stay in the conversation that owns them. Queued input that the fork inherited from an event prefix the source had since claimed is dropped, so the new conversation does not replay work the source already did.
- **Link** — `{sessionId, path, branch, baseCommit, repositoryRoot, policy}` is stored in the `dsh-worktree-links` KV unit (backend `json` by default) so the archive rule survives restarts.
- **Archive** — a `domain/changed` listener watches the workspace registry's durable archive set. For every newly archived conversation with a link it waits for a running Agent to become idle (bounded), then force-removes the checkout.
- **Removal** — `git worktree remove --force` under the conversation's sandbox policy, `git worktree prune` when the directory is already gone, and `git worktree unlock` + a second forced attempt for locked registrations. The created branch is kept by default.

## Configuration

The inserted row has no `config`; add these keys under it in the profile patch when needed:

| Key | Default | Meaning |
|---|---|---|
| `backend` | `json` | Storage backend holding session/worktree links. Falls back to the first backend with a KV facet. |
| `autoRemoveOnArchive` | `true` | Remove the worktree when its conversation is archived. |
| `removeBranch` | `false` | Also delete the created branch (becomes `git branch -D`). |
| `gitCommand` | `git` | Executable resolved through the subprocess provider. |
| `gitTimeoutMs` | `120000` | Per-git-command deadline. |
| `maxOutputBytes` | `65536` | Per-stream capture cap for git output. |
| `idleWaitMs` | `15000` | Bound on waiting for a running Agent before archive cleanup proceeds. |

## Behaviour and limits

- `/worktree` refuses to act when the current directory is not inside a Git checkout, or when the repository has no commit yet.
- When a conversation that already has turns is forked and worktree creation fails, the fork remains (there is no Session-deletion API) and the Git/filesystem artifacts that were already created are not rolled back. The error text says so.
- A new conversation with no turns is moved rather than forked, so `/worktree <message>` on the New Session screen starts that very conversation in the worktree. If the first turn is still running there is no completed turn to fork and no safe moment to move the directory, so `/worktree` reports that instead of forking.
- `/worktree off` refuses while the conversation's turn is running so a live shell is not yanked out from under it. Archive cleanup waits for idle instead.
- Removal is forced: uncommitted and untracked changes inside the worktree are discarded. Committed work is kept in the branch unless `removeBranch` is enabled.
- Removing a worktree outside DSH is fine: the next `/worktree off` or archive prunes the stale registration.
- If link storage is unavailable the command still works with in-memory links, but archive cleanup after a restart cannot find them.
- Running `/worktree` from a conversation that already works in a worktree creates the new checkout inside that checkout, following the mounted worktree runtime's own pool rule.
- In a CLI-only client the command still works, but the conversation is not opened automatically.
