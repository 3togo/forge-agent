# Forge Agent in AionUi

Forge provides a Linux ACP v1 stdio agent using the official ACP SDK. It uses
Forge's existing browser adapters and tools; no model API key is required.
Doubao is the default for the ACP launcher. DeepSeek and Gemini can be selected
with `--model=deepseek` or `--model=gemini`.

## Register in AionUi

Running `./forge-agent-acp` alone does not open AionUi or show a chat prompt.
It waits for protocol messages from a GUI client. Stop that terminal process
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

Dependencies are installed with `npm install`; if Chromium is missing, run
`npx playwright install chromium` from this checkout. Test Connection does not
open a browser, launch a worker, or contact the AI service.

## Login and browser ownership

The first prompt opens a visible browser. Log in there if requested; the GUI
reports that the browser is opening. There is no terminal Enter prompt. Forge
waits up to three minutes for the chat input to become available. Input readiness
is not proof of authentication: if the website asks for login after submitting,
complete login before retrying in a new chat.

The GUI uses `~/.deepseek-agent/acp-session`, separate from the interactive CLI
profile. It preserves its own cookies and login. Only one live browser can own
this profile. If another GUI connection owns it, close that connection first;
Forge does not kill it or delete profile locks. To intentionally run a second
instance, pass `--session-dir /absolute/different/profile` and log in separately.

Within one ACP connection, a single conversation owns the browser. More session
IDs can be created, but their prompts are rejected while another conversation
owns it. Start a separate connection/profile for concurrent conversations.

## Implemented behavior

- Standard ACP initialization, session creation, prompt completion, session
  updates, permission requests, and cancellation. Text and resource links are
  accepted. A resource link is passed as a reference, not automatically fetched.
- Worker processes bind config and tools to the selected workspace.
- Tool start/result events and bounded text-file diffs appear in the client.
  Final answers appear when Forge finishes; token-by-token answer streaming is
  not implemented.
- Mutating tools and tools that run code (including `run_tests`) require an
  explicit **Allow once** response. Decline, cancellation, connection errors,
  and unrecognized responses never grant approval. A decline ends the turn.
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

A live AionUi/Doubao round trip has not been verified in this implementation
session because the browser-control surface was unavailable. After registration,
first use Test Connection, then try a small project task and verify both Allow
once and Decline before a longer run.

The architectural reference was the local DuoBaoAgent project; see the
[original assessment](AIONUI-ASSESSMENT.md).
