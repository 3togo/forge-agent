# AionUi integration assessment

Reviewed 2026-09-17 against the local `/home/eli/git/DuoBaoAgent` reference and
the official ACP v1 documentation. The gaps below describe the pre-implementation
state. The first implementation
is now available; see [AIONUI.md](AIONUI.md) for supported behavior, tests, and
remaining live-GUI verification.

## Conclusion

AionUi support is feasible while keeping Forge's Node.js agent loop, tool set,
and DeepSeek/Gemini/Doubao adapters. Replace the existing experimental ACP
transport and add explicit agent lifecycle and approval hooks. Reuse the
reference's architecture and test scenarios; importing its Pi runtime is not
necessary to support AionUi.

The reference separates the ACP connection from per-conversation workers,
translates structured worker events into ACP updates, handles approval replies,
and stops workers on cancellation/disconnect. It also has durable session
recovery and a browser connection that can share a logged-in Chrome instance.
Those are distinct features; protocol support alone does not provide them.

## Confirmed gaps

| Area | Current Forge behavior | Required change |
|---|---|---|
| Handshake | Returns string `"0.12.1"` and `capabilities` | Negotiate integer protocol version with `agentCapabilities` and truthful feature declarations |
| Methods | `new_session`, `load_session`, `prompt`, `cancel` | Implement `session/new`, `session/prompt`, `session/cancel`, and optional `session/load` |
| Prompt and result | Reads `params.text`; returns a running acknowledgement before completion | Accept ACP content blocks; keep prompt request pending until a response with `stopReason` |
| Updates | Custom `Message`, `ToolCallStart`, and `session/end` notifications | Send `session/update` with standard message/tool update shapes |
| Stdout | Banner precedes ACP startup; wrapper also writes original terminal output | Reserve stdout for protocol messages from process start; route logs to stderr |
| Workspace | Records the GUI's `cwd` but uses the already-created shared agent/config | Validate workspace and construct a worker in that workspace before loading config and tools |
| Isolation | All sessions share one agent/browser/conversation | Isolate conversation state and serialize shared browser access or allocate owned tabs |
| Permissions | ACP permission helper is not wired into agent tools; non-TTY terminal menu returns `once` | Route approvals through `session/request_permission`; decline/cancel must never execute tools |
| Cancellation | Sends a notification without stopping work; shell commands use `execSync` | Keep transport responsive in a separate process; interrupt worker and owned command processes, settling the pending prompt |
| Loading | In-memory map only; advertises a nonstandard loading flag | Initially advertise no session loading; implement durable history and restoration before enabling it |
| Login | Browser login waits for terminal Enter | Provide GUI-visible login instructions and readiness polling or a separate explicit authentication step |
| Browser ownership | Every agent launches the same persistent profile | Define ownership and contention handling before supporting multiple conversations |

`smart-start.sh` is an interactive launcher, not an ACP entry point: its status
output also goes to stdout. It must not be registered unchanged as AionUi's
custom-agent command.

## Recommended implementation

1. **ACP transport and entry point.** Add a dedicated `forge-agent-acp` launcher
   and use the official JavaScript/TypeScript ACP SDK, with its version pinned
   after checking compatibility with the installed AionUi client. Bypass CLI
   banners/setup prompts. Connection testing must not open Chromium or contact
   a model. Start with text and resource-link input, no attachments/MCP, and no
   advertised durable session loading.
2. **Worker and workspace isolation.** Start a Node worker per conversation,
   loading Forge config/tools after setting its workspace. Communicate through
   structured IPC events and requests. Keep terminal output on stderr. This
   allows the ACP parent to process cancel/permission replies while a legacy
   synchronous tool blocks the worker. Explicitly reject overlapping prompts
   for the same conversation.
3. **Agent integration.** Add callbacks for messages, tool start/result, and
   permission requests. Preserve the existing CLI behavior when callbacks are
   absent. ACP approval policy must be explicit and must not inherit the
   non-TTY auto-approval fallback. Implement command-process ownership and
   cancellation; killing only the Node worker is insufficient if children survive.
4. **Browser lifecycle.** For an initial release, use a dedicated GUI profile,
   one live browser conversation, and an explicit busy response for another
   conversation. Never silently terminate an interactive CLI session. For
   multiple live conversations, adapt the reference's loopback CDP connection
   and owned-tab approach, verifying which browser/tab a worker may close.
   Login must work without reading the protocol stream as keyboard input.
5. **GUI validation.** Register a separate Forge custom agent in the existing
   AionUi installation. Verify connection, selected workspace, a Doubao reply,
   file editing with displayed tool output, command allow/deny, cancellation,
   disconnect cleanup, and browser-profile contention. Add durable restoration
   only after recording and replaying completed context correctly.

Keep model selection at process launch initially (for example the planned
`forge-agent-acp --model=doubao`). Add GUI model/config controls after the
basic lifecycle is reliable. That command is a proposed interface, not an
executable currently provided by this checkout.

## Verification performed

- Directly exercised Forge's current ACP handler with `initialize` and
  `session/new`, without starting a browser. Initialization returned
  `protocolVersion: "0.12.1"`; `session/new` returned `-32601`, unknown method.
- Ran `.venv/bin/python -m unittest doubaocli.tests.test_acp_agent -q` in the
  reference repository: **7 tests passed**. These use fake workers/clients and
  do not prove a current live Doubao or AionUi round trip.
- Reviewed the reference's documented historical AionUi validation, worker
  lifecycle, permissions, cancellation, and session restoration. No existing
  GUI configuration, browser session, or user files were changed for this review.

## Source map

Forge: `src/acp-server.js`, `src/index.js`, `src/agent.js`,
`src/permission-menu.js`, `src/tools.js`, `src/browser.js`.

Reference: `docs/AIONUI.md`, `doubaocli/acp_agent.py`,
`doubaocli/worker_process.py`, `doubaocli/pi_worker.py`,
`doubaocli/tests/test_acp_agent.py`, `local_launcher.py`.

The reference is MIT-licensed. Preserve its copyright/license notice when
copying substantial code; its Python/Pi implementation is best used as a design
reference for Forge's Node implementation.

Official protocol references:

- [Initialization and capabilities](https://agentclientprotocol.com/protocol/v1/initialization)
- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Prompt lifecycle and cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn)
