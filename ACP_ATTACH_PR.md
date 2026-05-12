# feat(cli): add ACP attach support

Closes #12853 (supersedes #18272 and #12743, both closed unmerged).

## What

Add `opencode acp --attach <url>` so the ACP stdio bridge can target an
existing `opencode serve` instance instead of always starting an
in-process backend. This unlocks multi-client workflows: a single
long-running server can host one or more editor ACP clients alongside
the TUI (`opencode attach`) and the browser UI (`opencode web`), with a
shared session store.

The local-backend code path is unchanged. `--attach` opts into the
proxy mode.

## Why

The same use case has been asked for repeatedly (#12853, #8890, #8458,
#8948, #6461, #11576) and two earlier PRs (#18272 by @shekohex and
#12743 by @georgeharker) addressed it but were closed without review.
This PR is rebased onto current `dev`, modernized to the post-Effect
`effectCmd` factory used by `opencode run --attach`, and fixes two
behavior bugs the earlier attempts had.

## CLI surface

```bash
# Default: spawn a local server, same as before.
opencode acp

# Bridge ACP stdio to an existing server.
opencode acp --attach http://localhost:4096

# Optionally pick a directory on the remote server.
opencode acp --attach http://localhost:4096 --cwd /path/to/project

# Basic auth (mirrors `opencode run --attach` and `opencode attach`).
opencode acp --attach http://localhost:4096 --password "$OPENCODE_SERVER_PASSWORD"
```

Flag table:

| Flag                     | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `--attach <url>`         | URL of a running `opencode serve` to proxy to                     |
| `--cwd <path>`           | Working directory (path on the remote server when attaching)      |
| `--password, -p <pw>`    | Basic auth password (defaults to `OPENCODE_SERVER_PASSWORD`)      |
| `--username, -u <user>`  | Basic auth username (defaults to `OPENCODE_SERVER_USERNAME` or `opencode`) |

Docs updated in `packages/opencode/src/acp/README.md`, `packages/web/src/content/docs/{,pl/,tr/,zh-cn/}{acp,cli}.mdx`.

## Implementation notes

The handler lives in `packages/opencode/src/cli/cmd/acp.ts`.

- `createOpencodeClient` is the only branch point: when `--attach` is
  set, `baseUrl` becomes the user-supplied URL and no local server is
  started; otherwise the existing `Server.listen()` path runs.
- `directory: args.cwd` is forwarded to the SDK in both branches. The
  remote server reads it as the `x-opencode-directory` header (see
  `workspace-routing.ts:defaultDirectory`) and routes the request to /
  on-demand-creates the matching workspace.
- `headers: ServerAuth.headers({ password, username })` mirrors
  `run.ts` so basic auth works without env-var-only configuration.

### Two pitfalls worth flagging for reviewers

Both of these were present in #18272 (and would silently break the
attach path in real use):

1. **`--cwd` must not default to `process.cwd()`.** If `--cwd` falls
   back to the acp process's cwd, the SDK always sends an
   `x-opencode-directory` header pointing at the editor's spawn
   directory rather than the server's workspace. The remote server then
   tries to load an instance for a path it may not own, which fails
   with `"No context found for instance"`. The fix is to leave `--cwd`
   optional so the SDK passes `directory: undefined` and the server
   resolves to its own `process.cwd()` by default — matching how
   `opencode attach --dir` already behaves.

2. **The local `InstanceContext` must still be loaded in attach mode.**
   It's tempting to set `instance: (args) => !args.attach` to skip the
   project bootstrap when proxying, by analogy with `run.ts --attach`.
   But the ACP agent itself has local-only code paths that read
   `Instance.current` from AsyncLocalStorage — notably
   `resolveModeState` in `acp/agent.ts:1097` calling
   `AgentModule.Service.defaultAgent()`. Without a loaded local
   instance, that read throws `NotFound("instance")` on
   `session/new`. The fix is to leave `effectCmd`'s `instance: true`
   default. There's a small cost (config + plugin init runs locally
   too), but it's required for correctness.

A comment in the source spells out the second point so the next person
to optimize doesn't trip over it.

## How verified

- `bun --filter='opencode' typecheck` — no errors introduced by this
  patch in `acp.ts` (pre-existing errors in `tui/config/keybind.ts` and
  `image/image.ts` remain on `dev` and are out of scope).
- Manual JSON-RPC handshake (sanity check that the bridge speaks ACP):
  ```bash
  opencode serve --port 4096
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n' \
    | opencode acp --attach http://localhost:4096
  # → returns initialize response with agentCapabilities + authMethods
  ```
- End-to-end with an ACP editor client (Emacs `agent-shell`): start
  `opencode serve --port 4096` from a project directory, configure
  `agent-shell-opencode-acp-command` to `("opencode" "acp" "--attach"
  "http://localhost:4096")`, send a prompt — replies stream back, and
  `opencode session list` shows the session under that project.

## Out of scope / follow-ups

- WebSocket / streaming endpoints behind `--attach` go through the
  existing `proxyRemote` path in `workspace-routing.ts` (Fence-based
  sync). I haven't exercised every endpoint manually; the model is the
  same one `opencode run --attach` uses, so anything that breaks should
  break there too.
- No tests added. Adding integration tests for ACP-over-attach would
  require spinning up a real `opencode serve` and an ACP client in the
  test harness; happy to do that if reviewers want it before merge.

## History (for reviewers picking this up cold)

This PR's branch (`acp-attach`) starts from @shekohex's two commits on
#18272, with the conflict resolution done as a single rewritten commit
on top of current `dev`. Original commit 2 (`fix(cli): bootstrap
attached acp sessions`) was folded into the resolution because the
post-`effectCmd` architecture no longer uses the `bootstrap()` wrapper
the fix was tweaking. Author attribution preserved on the resulting
commit.
