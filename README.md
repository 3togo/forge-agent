# 🔨 Forge Agent

**Autonomous AI Coding Agent — No API Key Needed**

Forge Agent drives DeepSeek, Gemini, Doubao (豆包), or Yuanbao (元宝) through browser
automation to code, test, and ship software — completely free.

[![npm version](https://img.shields.io/npm/v/@omar-azam/forge-agent)](https://www.npmjs.com/package/@omar-azam/forge-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1300%2B%20passing-brightgreen)](#)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fomar--azam%2Fforge--agent-blue)](https://github.com/Omar-Azam/forge-agent/pkgs/container/forge-agent)

---

## 💙 Sponsors

Forge Agent is free and open source. If it saves you time:

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github)](https://github.com/sponsors/Omar-Azam)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi)](https://ko-fi.com/forgeagent)

---

## Why Forge Agent?

- **Free** — No API key. Uses DeepSeek, Gemini, Doubao, or Yuanbao's free web UI.
- **Autonomous** — Reads files, writes code, runs tests. Loops until done.
- **Cross-platform** — Linux, macOS, Windows, and Docker.
- **50 days built** — 37+ tools, 1300+ tests, full docs, security audited.

---

## Installation

### Prerequisites

- **Node.js 18+** and **npm** — [Download from nodejs.org](https://nodejs.org/)
- **Linux** required for ACP/GUI mode (AionUi); CLI mode works on macOS and Windows too
- A **desktop display** (non-headless) for first-time login to any model

### Option 1: npm (Recommended)

```bash
npm install -g @omar-azam/forge-agent
```

This installs three commands on your PATH:
- `forge-agent` — main CLI entry point
- `fa` — short alias for `forge-agent`
- `forge-agent-acp` — ACP protocol server for GUI integration (Linux only)

### Option 2: Docker (No Node.js Required)

```bash
docker pull ghcr.io/omar-azam/forge-agent:latest
```

### Option 3: From Source

```bash
git clone https://github.com/Omar-Azam/forge-agent.git
cd forge-agent
npm install
```

Use `node src/index.js` or `./forge-agent-acp` from the checkout.

---

## Quick Start

### Step 1: Run Setup

```bash
forge-agent --setup
```

This installs:
- Missing npm dependencies (Playwright, ACP SDK)
- Chromium browser engine (via `npx playwright install chromium`)

### Step 2: Run a Task

```bash
# One-shot task
forge-agent "build a REST API with Express and JWT auth"

# Interactive mode — multiple tasks, shared context
forge-agent --interactive

# Short alias
fa "add TypeScript to this project"
```

### Step 3: First Login

On first run, a browser window opens automatically. **Log in to the model's website** (DeepSeek, Gemini, Doubao, or Yuanbao) when prompted. After a successful reply, your login is saved and restored in future sessions — no need to log in again.

---

## Yuanbao with AionUI

Log in independently, then use the Yuanbao agent in AionUI:

```bash
node src/index.js --login --model=yuanbao
```

The login window closes when the site is ready and credentials are saved.
AionUI chats run in a background browser without stealing focus. Each chat
reports a local monitor file: open it to watch screenshots, exact browser
prompts, replies, and errors. See [login and monitoring](docs/AIONUI.md#login-and-browser-ownership).

## Setting Up the Doubao (豆包) Agent

Doubao is ByteDance's free AI chat service at [www.doubao.com/chat](https://www.doubao.com/chat). It has a Chinese-language UI and is the **default model for ACP/GUI mode**.

### Step 1: Install Forge Agent

```bash
npm install -g @omar-azam/forge-agent
```

### Step 2: Run Setup with Doubao

```bash
# CLI mode setup
forge-agent --setup --model=doubao

# Or ACP mode setup (for GUI integration via AionUi)
forge-agent-acp --setup --model=doubao
```

This installs all dependencies and Chromium. The `--setup` flag exits after installation without launching the agent.

### Step 3: First Login to Doubao

```bash
# Start the agent with Doubao — a browser window will open
forge-agent --model=doubao "hello"

# Or use the Chinese alias
forge-agent --model=豆包 "hello"
```

When the browser opens:
1. Navigate to the Doubao chat page (it loads automatically)
2. **Log in with your Doubao/ByteDance account** (phone number, WeChat, etc.)
3. After login, the agent detects the chat input is ready and sends your prompt
4. Once you receive a successful reply, your login state is saved to `~/.deepseek-agent/acp-auth/doubao.json`
5. Future sessions restore this login automatically — no repeated logins needed

> **Note:** If Doubao expires your session (happens periodically), you'll need to log in again. The agent detects this and opens the browser for re-authentication.

### Step 4: Configure Doubao as Default (Optional)

Create or edit `~/.deepseek-agent/config.json`:

```json
{
  "MODEL": "doubao",
  "MAX_ITERATIONS": 100,
  "RESPONSE_TIMEOUT": 600000,
  "HEADLESS": false
}
```

Or create `./forge-agent.config.json` in your project directory (overrides global config):

```json
{
  "MODEL": "doubao",
  "HEADLESS": false,
  "MAX_ITERATIONS": 100,
  "RESPONSE_TIMEOUT": 600000,
  "STABLE_DELAY": 1500,
  "SEND_DELAY": 600,
  "MAX_OUTPUT_LENGTH": 8000,
  "DEBUG": false
}
```

After this, `forge-agent "task"` uses Doubao by default without `--model=doubao`.

### Step 5: Use Doubao via AionUi GUI (Linux Only)

For a desktop GUI experience, use the ACP protocol with AionUi:

```bash
# Install AionUi (the launcher offers to download it if not found)
forge-agent-acp --model=doubao
```

Then in **AionUi → Settings → Agent Management → Custom Agents**, add:

| Field | Value |
|---|---|
| Name | Forge Browser Agent |
| Command | `forge-agent-acp` (or full path) |
| Arguments | `--model=doubao` |
| Environment | Leave empty |

Click **Test Connection**, save, then start a new chat with this agent. Select **Work in a project** and choose your repository before sending a task.

> If AionUi can't find Node (e.g., NVM not loaded), use absolute paths:
> ```
> Command:   /home/<user>/.config/nvm/versions/node/v24.21.0/bin/node
> Arguments: /home/<user>/git/forge-agent/src/acp-entry.js --model=doubao
> ```

### Doubao-Specific Notes

- **ProseMirror editor**: Doubao uses a ProseMirror contenteditable editor. The agent handles this automatically with `fill()` + text verification.
- **Virtual list**: Doubao's chat uses a virtual scrolling list. The agent detects response completion via content changes, not row count.
- **Chinese UI**: All Doubao UI elements use Chinese text. The agent's selectors match Chinese labels (e.g., `发消息`, `新对话`, `发送`).
- **Session isolation**: Each ACP conversation gets its own browser profile at `~/.deepseek-agent/acp-profiles/doubao/<session-id>/`.
- **Shared login**: After a successful Doubao reply, cookies and localStorage are saved to `~/.deepseek-agent/acp-auth/doubao.json` and shared with new conversations.

---

## Usage

### Basic Commands

```bash
# One-shot task
forge-agent "build a REST API with Express and JWT auth"

# Interactive mode — multiple tasks, shared context
forge-agent --interactive

# Short alias
fa "add TypeScript to this project"

# Specify working directory
forge-agent --dir=/path/to/project "task"

# Plan mode — agent plans before executing
forge-agent --plan "refactor the auth module"

# Think mode — deeper reasoning
forge-agent --think "design a microservices architecture"
```

### Model Selection

```bash
forge-agent --model=deepseek "task"   # Default, best tool-call reliability
forge-agent --model=gemini "task"     # Google's free tier
forge-agent --model=doubao "task"     # ByteDance's 豆包 (also: --model=豆包)
forge-agent --model=yuanbao "task"    # Tencent's 元宝 (also: --model=元宝)
```

### Agent Profiles

```bash
forge-agent --profile=backend      # Node.js, Python, Go, REST APIs
forge-agent --profile=frontend     # React, Vue, HTML/CSS
forge-agent --profile=data-science # Python, pandas, ML
forge-agent --profile=devops       # Docker, CI/CD, shell scripts
```

### Task Templates

```bash
forge-agent --template=add-typescript    # Add TypeScript to any JS project
forge-agent --template=add-jest          # Set up Jest testing
forge-agent --template=add-docker        # Dockerfile + docker-compose
forge-agent --template=add-github-actions # CI/CD pipeline
forge-agent --template=fix-tests         # Run and fix all failing tests
forge-agent --template=code-review       # Comprehensive code review
forge-agent --list-templates             # See all 10 templates
```

### Session Resume

```bash
forge-agent --history         # Browse past tasks
forge-agent --resume          # Pick and resume a past task
forge-agent --resume=last     # Resume most recent task immediately
forge-agent --rerun           # Re-run most recent task fresh
```

### Linux Smart Start Script

```bash
./smart-start.sh                  # Recover a suspended instance and start interactively
./smart-start.sh --check          # Inspect only; exits nonzero if the session is busy
./smart-start.sh --restart        # Explicitly stop the existing instance, even if active
./smart-start.sh --interactive --debug
```

The script uses `forge-agent` from your PATH and its configured `SESSION_DIR`.
Set `FORGE_AGENT_BIN` to select a specific installed executable.

### Docker

```bash
# Single task
docker run --rm -v "$(pwd):/workspace" --network host \
  ghcr.io/omar-azam/forge-agent "build a REST API"

# Interactive
docker run --rm -it -v "$(pwd):/workspace" --network host \
  ghcr.io/omar-azam/forge-agent --interactive

# With Make
make run TASK="build a REST API"
make interactive
```

### Custom Plugins

```js
// ~/.deepseek-agent/tools/fetch_weather.js
module.exports = {
  name: 'fetch_weather',
  description: 'Get current weather for a city',
  parameters: { city: { type: 'string', required: true } },
  async execute({ city }) {
    const https = require('https');
    return new Promise((res, rej) => {
      https.get(`https://wttr.in/${city}?format=3`, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    });
  },
};
```

```bash
forge-agent --list-plugins       # see all loaded plugins
forge-agent --new-plugin my_tool # generate a stub
```

---

## CLI Reference (Key Flags)

```
forge-agent [OPTIONS] [TASK]

Core:      --interactive -i  --dir  --model  --profile  --plan  --think
Models:    --model=deepseek  --model=gemini  --model=doubao  --model=yuanbao
Sessions:  --resume  --rerun  --history  --no-memory
Templates: --template  --list-templates  --save-template
Output:    --format  --output  --no-tui  --compact
ACP:       --acp  (stdio JSON-RPC for GUI integration)
Watch:     --watch  --watch-pattern  --watch-debounce
Performance: --max-iterations  --timeout  --no-timeout
Plugins:   --list-plugins  --new-plugin
Config:    --setup  --config-path
Debug:     --debug  --headless  --diagnostics  --security
Help:      --help  --help=<topic>  --cheatsheet  --man
```

Full reference: `forge-agent --help` or [docs/cli-reference.html](docs/cli-reference.html)

---

## Configuration

### Global Config

```json
// ~/.deepseek-agent/config.json
{
  "MODEL": "deepseek",
  "MAX_ITERATIONS": 100,
  "RESPONSE_TIMEOUT": 600000,
  "ACTIVE_PROFILE": "default",
  "MEMORY_ENABLED": true,
  "CACHE_ENABLED": true
}
```

### Project Config (Overrides Global)

```json
// ./forge-agent.config.json
{
  "MODEL": "doubao",
  "HEADLESS": false,
  "MAX_ITERATIONS": 100
}
```

### Supported Models

| Model | URL | Notes |
|---|---|---|
| `deepseek` | chat.deepseek.com | Default, best tool-call reliability |
| `gemini` | gemini.google.com/app | Google's free tier |
| `doubao` | www.doubao.com/chat | ByteDance's 豆包, Chinese UI, ACP default |
| `yuanbao` | yuanbao.tencent.com/chat | Tencent's 元宝, Chinese UI |

### Key Configuration Options

| Option | Default | Description |
|---|---|---|
| `MODEL` | `deepseek` | Which AI model to use |
| `HEADLESS` | `false` | Run browser without visible window (set `true` for Docker) |
| `MAX_ITERATIONS` | `100` | Maximum agent loop iterations |
| `RESPONSE_TIMEOUT` | `600000` | Total wait timeout in ms (10 min) |
| `STABLE_DELAY` | `1500` | Text stability check delay in ms |
| `SEND_DELAY` | `600` | Delay after filling input in ms |
| `MAX_OUTPUT_LENGTH` | `8000` | Maximum response text length |
| `DEBUG` | `false` | Enable debug logging |

### File Locations

| Path | Purpose |
|---|---|
| `~/.deepseek-agent/config.json` | Global configuration |
| `./forge-agent.config.json` | Project-level configuration (overrides global) |
| `~/.deepseek-agent/session/` | Browser session data |
| `~/.deepseek-agent/acp-auth/doubao.json` | Saved Doubao login state |
| `~/.deepseek-agent/acp-profiles/doubao/<session-id>/` | Per-session browser profiles |
| `~/.deepseek-agent/tools/` | Custom plugin directory |
| `~/.deepseek-agent/acp-permissions/` | Persistent file-write approvals |

Run `forge-agent --setup` for guided configuration.

---

## Features

| Feature | Description |
|---|---|
| 🌐 Browser Automation | Drives DeepSeek, Gemini, Doubao, Yuanbao — no API key |
| 🔧 37+ Built-in Tools | File I/O, git, shell, search, tests, packages, diff, env, processes |
| 💾 Persistent Memory | Remembers project tech stack and past tasks |
| 🎭 Agent Profiles | default, backend, frontend, data-science, devops |
| 📋 Task Templates | 10 built-in templates — add TypeScript, Jest, Docker in one command |
| 🔄 Session Resume | Continue tasks that stopped halfway |
| 📡 ACP Protocol | Stdio JSON-RPC for GUI integration (AionUi, etc.) |
| 👁 Watch Mode | Auto re-run on file changes |
| 🔌 Custom Plugins | Drop a .js file to add any tool |
| 🔒 Security Sandbox | Blocks SSH keys, credentials, path traversal |
| 🐳 Docker Ready | Official image, no local Node.js setup needed |
| ⚡ Smart Caching | Skips repeated read-only tool calls |
| 🗜 Context Compression | Auto-compresses long conversations |
| 📊 Benchmarks | Measure and compare performance |

---

## Built-in Tools (37+)

**File:** read_file · write_file · append_to_file · replace_in_file · delete_file · move_file · copy_file · create_directory · list_directory · get_file_info · write_files

**Search:** search_in_files · search_codebase · find_files

**Shell:** run_command · start_process · stop_process · list_processes · read_process_logs

**Git:** git_status · git_log · git_diff · git_branches · git_show · git_blame

**Dev:** run_tests · install_package · diff_files · patch_file

**Env:** read_env · set_env_var · delete_env_var · list_env_files · check_env_vars

**System:** take_screenshot · read_clipboard · write_clipboard

---

## ACP Protocol (GUI Integration)

Forge Agent provides a Linux ACP v1 stdio server for clients such as AionUi,
with GUI tool approvals, workspace isolation, and cancellation.

```bash
# After npm install -g .
forge-agent-acp --model=doubao

# From source checkout
./forge-agent-acp --model=doubao

# Via main CLI
forge-agent --acp --model=doubao
```

Doubao is the **default model** for ACP mode. Use `--model=deepseek` or `--model=gemini` to switch.

See the [AionUi setup guide](docs/AIONUI.md) for detailed registration, login, and current limits.

---

## Key Stats — v2.0.0

- 🔧 **37+ tools** built in
- 🧪 **1300+ tests** across 49 suites
- 📁 **13 docs pages** including full CLI reference
- 📋 **10 task templates** built in
- 💡 **10 example projects** in gallery
- ⚙️ **40+ CLI flags**
- 🐳 **Docker image** published
- 🔒 **Security audited** with path sandbox
- 📦 **50 days** of development

---

## Documentation

Full documentation: [https://omar-azam.github.io/forge-agent](https://omar-azam.github.io/forge-agent)

- [Getting Started](docs/getting-started.html)
- [All Tools](docs/tools.html)
- [CLI Reference](docs/cli-reference.html)
- [Agent Profiles](docs/profiles.html)
- [Task Templates](docs/templates.html)
- [Custom Plugins](docs/plugins.html)
- [Docker Guide](docs/docker.html)
- [Configuration](docs/configuration.html)
- [Security](docs/security.html)
- [Examples Gallery](docs/examples.html)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup,
code style, and how to add new tools.

All contributions welcome: new tools, bug fixes, docs improvements,
new templates, plugin examples.

---

## Support This Project

Forge Agent is free and open source. If it saves you time:

- ⭐ **Star the repo** — helps others discover it
- 💰 **[Sponsor development](https://github.com/sponsors/Omar-Azam)**
- 📢 **Share it** — post about it, tell your team
- 🐛 **Report bugs** — good reports make it better
- 📝 **Improve docs** — any PR helps

---

## License

MIT — see [LICENSE](LICENSE)
