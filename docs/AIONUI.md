# Forge Agent in AionUi

Forge provides a Linux ACP v1 stdio agent using the official ACP SDK. It uses
Forge's existing browser adapters and tools; no model API key is required.
Doubao is the default for the ACP launcher. DeepSeek and Gemini can be selected
with `--model=deepseek` or `--model=gemini`.

## Register in AionUi

Run `./forge-agent-acp --register` to automatically register all supported models
(DeepSeek, Gemini, Doubao) as custom ACP agents in AionUi. This writes directly
to the AionUi database, so close AionUi first to avoid conflicts. After registering,
restart AionUi and the agents appear in Settings → Agent Management → Custom Agents.

```
./forge-agent-acp --register              # Register all models
./forge-agent-acp --register --model=deepseek  # Register only DeepSeek
./forge-agent-acp --list-agents           # List registered Forge agents
./forge-agent-acp --unregister            # Remove all Forge agents
./forge-agent-acp --unregister --model=gemini  # Remove only Gemini
```

For API-based providers (requires API keys), use `--api`:
```
./forge-agent-acp --register --api        # Register as API providers
```

Manual registration is still available:
Existing AionUi processes owned by your user receive SIGTERM; after eight seconds,
unresponsive processes receive SIGKILL. Active chats disconnect during restart.
Without a desktop display, the launcher leaves existing processes alone.
The GUI continues running after Ctrl+C stops this
terminal server. Startup errors are recorded in `~/.local/state/forge-agent/aionui.log`.
The terminal waits for protocol messages from a GUI client. The launcher
checks PATH and common AppImage locations for AionUi. If it is not detected,
it offers to download the latest official Linux installer for x64 or arm64 and
install it using `sudo apt install` (Debian/Ubuntu). Accept with `y`; sudo may
ask for your password. Installation errors stop startup with recovery guidance.
Client launches never prompt, install, or open AionUi. `--setup` installs prerequisites
without opening the GUI. Stop that terminal process
with Ctrl+C and configure AionUi to launch the command automatically below.

In **Settings → Agent Management → Custom Agents**, add a new agent:

| Field | Value for this checkout |
|---|---|
| Name | Forge Browser Agent |
| Command | `/home/eli/git/forge-agent-omar/forge-agent-acp` |
| Arguments | `--model=doubao` |
| Environment | Leave empty if `node` and the desktop display are available |

Use **Test Connection**, save, then choose the agent for a new chat. Select
**Work in a project** and choose the repository before sending a task. The
session's working directory controls Forge's file tools and project context.
Writing a directory path in the prompt does not change the workspace.

If AionUi cannot find Node (for example an NVM environment is not loaded), use
an absolute Node executable as Command and pass both the absolute
`src/acp-entry.js` path and `--model=doubao` as Arguments. On this machine:

```text
Command:   /home/eli/.config/nvm/versions/node/v24.21.0/bin/node
Arguments: /home/eli/git/forge-agent-omar/src/acp-entry.js --model=doubao
```

After `npm install -g .`, `forge-agent-acp --model=doubao` is also available.
`forge-agent --acp --model=doubao` routes to the same entry point. Do not use
`smart-start.sh` as the GUI command: its diagnostic output is intended for a
terminal, not an ACP client.

Run `./forge-agent-acp --setup` to install missing runtime packages and Chromium.
When launched in a terminal, Forge identifies missing dependencies and offers to
install them before displaying the connection instructions. AionUi launches never
prompt or install automatically; setup instructions go to stderr so ACP stdout
stays valid JSON. Node.js 18 or newer and npm must be installed first.

Dependencies can also be installed with `npm install`; if Chromium is missing, run
`npx playwright install chromium` from this checkout. Test Connection does not
open a browser, launch a worker, or contact the AI service.

Composer and response-wait errors end the turn with a visible explanation and
keep the browser running for inspection through the monitor. Retry in the same chat after
resolving the issue; if a message was already sent, check its reply first.
Canceling an active turn or closing the connection still stops the worker and browser.

Ordinary conversational replies are returned to AionUi immediately, including
answers following project file reads. Coding tool calls still follow the agent loop and
approval flow.

Workspace mappings for sessions are saved under `~/.deepseek-agent/acp-sessions`.
If AionUi reconnects using a known session ID, Forge restores the workspace and
reports that conversation context has reset. It does not replay earlier actions
or claim to restore chat history (`session/load` remains unsupported). Session
IDs created before this feature require one new AionUi chat. Unknown IDs, changed
models, and missing workspaces are rejected with instructions to start a new chat.

## Login and browser ownership

Log in separately before using Yuanbao in AionUI:

```bash
node src/index.js --login --model=yuanbao
```

This opens a dedicated login browser profile, waits up to three minutes for site
readiness, saves credentials, and closes the window. No task is sent and no Enter
key is required. Running it again checks the website even when saved credentials
exist. After renewing login, start a new AionUI chat.

AionUI workers run headlessly, including when credentials are missing or expired.
They never initiate QR login or open an authentication window. If the page is not
ready, the turn ends with the separate login command. Site readiness remains a
heuristic; providers may still require authentication upon submission.

### Monitor browser input and output

The first prompt reports an **Open browser monitor** HTTP link. Open it in your
browser; the read-only viewer listens only on localhost and uses an unguessable
URL. It refreshes every three seconds with screenshots and the latest 30 events:
exact prompts passed to the browser (including agent instructions/tool results),
completed provider replies, and errors. Screenshots show in-progress generation.
The monitor never brings the automated browser to the foreground.

The HTTP link lasts while the worker is running. The archive remains at
`~/.deepseek-agent/acp-profiles/<model>/<session-id>/monitor/index.html`.
If your browser cannot read local files, serve an existing archive with:

```bash
node src/browser-monitor.js /absolute/path/to/monitor/index.html
```

Open the localhost URL printed by that command; Ctrl+C stops the archive viewer.

The adjacent `events.jsonl` preserves the full event history and can also be
watched with `tail -f`. These owner-only local files contain chat content and
screenshots; delete the session's `monitor` directory when no longer needed.
A force-killed worker may leave the last snapshot without a closed status; check
the displayed timestamp. To inspect an actual browser window deliberately, set
`FORGE_ACP_HEADED=1` in the custom agent environment. This does not enable login
inside AionUI.

Each ACP conversation uses `~/.deepseek-agent/acp-profiles/<model>/<session-id>`.
This keeps simultaneous chats and project chats from competing for the same
Chromium profile. A restored session reuses its profile and saved login. After a successful provider reply, cookies and local storage for that model are
saved in `~/.deepseek-agent/acp-auth/<model>.json` with owner-only permissions.
New conversations restore that login into their isolated profiles. You may need
to log in once after upgrading, or again when Doubao expires the session. The older shared `acp-session` profile
is left in place; existing running conversations continue using it until closed.
An explicit `--session-dir` overrides this isolation, so use different directories
for simultaneous conversations when setting that option. Explicit profiles do
not participate in shared login state.

One ACP connection can host multiple conversations with independent workers and
browser profiles. When an explicit `--session-dir` is supplied, only one
conversation can own that profile; use a separate connection and profile for
another conversation.

## Implemented behavior

- Standard ACP initialization, session creation, prompt completion, session
  updates, permission requests, and cancellation. Text and resource links are
  accepted. A resource link is passed as a reference, not automatically fetched.
- Worker processes bind config and tools to the selected workspace.
- Tool start/result events and bounded text-file diffs appear in the client.
  Final answers appear when Forge finishes; token-by-token answer streaming is
  not implemented.
- File-write approvals offer **Allow once**, **Allow project file writes for
  this chat**, and **Allow always: file writes in this project**. Chat approval
  lasts for that conversation; always approval persists across agent restarts
  and future chats for the same canonical project path. This covers writing,
  appending, replacing, patching, batch writes, and creating directories.
  Deletion, moving files, commands, tests, and other tools still require their
  own **Allow once** approval. Project path and symlink checks remain enforced.
  Permanent grants are stored as owner-only JSON files under
  `~/.deepseek-agent/acp-permissions/`. To revoke one, delete the JSON file whose
  `workspace` matches your project, then start a new chat.
  Decline, cancellation, connection errors, and unrecognized responses never
  grant approval. A decline ends the turn.
  Saved terminal permissions do not bypass these GUI approvals.
- File-path checks and strict workspace mode apply to file tools. Approved shell
  commands still run as your Linux user; this is not an OS sandbox.
- Cancel and disconnect stop the worker and tracked child processes, including
  blocking command tools. Completed file changes remain. Cancelled/interrupted
  sessions reject further prompts; create a new chat. Tasks are not automatically
  replayed after worker failure.
- Logs go to stderr; stdout contains only protocol messages.

Session restoration, MCP servers, images/audio, GUI model switching, and terminal
slash commands are not supported. Select the model at launch. Sessions retain
context only while their worker/connection remains alive; `loadSession` is
advertised as false. A process deliberately daemonized/reparented before it can
be tracked is outside the worker cleanup guarantee.

## Verification

```bash
npm test -- --runTestsByPath tests/acp.test.js tests/acp-agent-hooks.test.js
```

The tests exercise the real ACP SDK over stdio, actual file tools, approvals and
diffs, workspace checks, the real agent-loop execution hook, cancellation of a
blocking shell process and its children, and disconnect cleanup. Browser/model
responses are replaced by fixtures; no AI website is contacted by these tests.

A live Doubao-to-ACP reply has been verified using the production agent and the
official ACP client SDK. To repeat the live smoke test (this contacts Doubao):

```bash
node scripts/acp-live-check.mjs
# Yuanbao, including saved-login preflight and monitor verification:
node scripts/acp-live-check.mjs --model=yuanbao
# Exercise show_info answers followed by TASK_COMPLETE:
node scripts/acp-live-check.mjs --model=yuanbao --show-info
```

It checks two turns in one conversation and another independent conversation,
using a temporary empty project and denying tool permission requests. It verifies the selected model’s saved login in a fresh headless profile before
starting the test. The default model is Doubao. It also checks that each session’s
monitor records browser input/output and contains a screenshot. This verifies the provider and ACP transport; AionUi's
rendering still needs a separate check through an authenticated AionUi client.

The architectural reference was the local DuoBaoAgent project; see the
[original assessment](AIONUI-ASSESSMENT.md).
