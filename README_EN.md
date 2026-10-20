# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="360" />
</p>

<p align="center">
  <strong>A local-first AI workspace</strong><br />
  Write code, run tests, drive web pages, and join QQ groups and Discord channels, with your data kept on your own machine.
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README_EN.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><img src="https://img.shields.io/github/v/release/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github&label=Releases" alt="Latest Release" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Komeiji-Shiki/Gray-Code/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue?style=flat-square" alt="AGPL-3.0-only with Cubism exception" /></a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><strong>Download</strong></a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="wiki/Home.md">Manual (Chinese)</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

![A single request: GrayCode searches the code, edits files, runs the tests, and shows the changes in the review panel](wiki/assets/workbench.png)

GrayCode is a desktop AI workspace for Windows x64. It understands your project, searches and edits code, runs commands and checks the results, and lets you review every change as a diff. The same conversations, models, and tools also reach the built-in browser, QQ, and Discord. Conversations, memory, and settings stay on your machine, and you choose the model providers.

## What it does

### From one request to passing tests

The screenshot above is a real tool loop: the model searches and reads the login route, adds a rate limiter, updates the route, writes tests, runs `npm test` to confirm they pass, and the review panel on the right shows the red and green diff for each file.

- **Real code operations**: read, search, and edit files, run terminal commands, and query language services for definitions and references. High-risk commands wait for your confirmation.
- **Reviewable, reversible changes**: every write keeps a diff, and checkpoints restore the workspace to the state before any turn.
- **Branching conversations**: retries and edits never overwrite earlier answers. Every candidate branch can be switched to and continued, optionally restoring the matching workspace checkpoint.
- **Parallel Git worktrees**: run several tasks in isolated worktrees without disturbing your source tree.

### Prompts you control entry by entry

![Preset prompt entries: a disabled entry, the chat history slot, and an assistant entry with a prefilled thought](wiki/assets/prompt-entries.png)

Each mode is a preset assembled from ordered prompt entries, edited one by one like a SillyTavern preset:

- **Toggle and reorder**: drag or move entries, and enable or disable any single entry without rewriting the whole prompt.
- **Choose the role**: an entry can merge into the system prompt or be inserted as a temporary user or assistant message.
- **Decide where history goes**: Chat History is itself an entry. Entries after it appear right before the current user message, which suits per-turn reminders. Dynamic context from earlier turns stays in place, so the request prefix remains stable.
- **Prefilled thoughts**: an assistant entry can carry a preset reasoning passage that simulates a reply with visible thinking.
- **Dynamic modules**: insert variables such as `{{$ENVIRONMENT}}`, `{{$WORKSPACE_FILES}}`, and `{{$MEMORY}}` directly into entries, and add character cards and worldbooks as reference entries.
- **Modes on demand**: chat, coding, and character modes each pick a default preset, and presets can be duplicated, exported, or imported from others.

### It reads web pages, and it can click them too

![The model opens a board page in the built-in browser, adds a to-do, and checks off a finished item](wiki/assets/browser.png)

- **Built-in browser**: the model reads page snapshots with element references, then fills forms, clicks buttons, toggles checkboxes, and uploads or downloads files. Each step returns the new page state, so every action can be verified.
- **Computer use**: operate Windows applications through screenshots and the UI Automation tree when a task only exists in a graphical interface.
- **Stays out of your way**: browser tabs run in the background and remain open after the task, ready for you to take over.

### Official DeepSeek web search and fetch

The built-in `web_search` and `web_fetch` tools call the official DeepSeek Search and Fetch APIs:

- Search results include title, link, summary, site, date, and authority level, with `site:`, `lang:`, and `after:` operators.
- Fetch returns the page as Markdown, and long pages can be read in pages.
- Credentials live in **Settings → Tools → Web Search**, independent of model providers, so models served through third-party relays can search too. Without credentials the two tools are not sent to the model.

### At home in QQ groups and Discord channels

![After a QQ group member asks a question, GrayCode searches the official docs and replies in the group](wiki/assets/bot.png)

<table>
  <tr>
    <td width="50%"><img src="wiki/assets/onebot-settings.png" alt="NapCat / OneBot connection settings" /></td>
    <td width="50%"><img src="wiki/assets/discord-settings.png" alt="Discord Bot default reply settings" /></td>
  </tr>
  <tr>
    <td align="center">NapCat / OneBot (QQ)</td>
    <td align="center">Discord Bot</td>
  </tr>
</table>

- **One set of capabilities, many entrances**: group chats, channels, and direct messages reuse the desktop agents, models, prompts, and tools, and every bot conversation can be inspected on the desktop.
- **Per-conversation settings**: choose the agent, provider, model, preset, workspace, and tools for each group, channel, or direct message, triggered by mentions, replies, keywords, or commands.
- **Identity and permissions**: bind QQ and Discord accounts to GrayCode accounts. Unbound members only get the permissions you grant.
- **Chats like a group member**: collects and sends stickers, saves received images to the conversation workspace, and splits long replies, sends them as files, or forwards them as a bundle. Failed deliveries can be retried after confirmation.

### Every request in plain sight

![Run history and the actual request body](wiki/assets/diagnostics.png)

- **Run history**: a full timeline of queueing, model responses, tool execution, and approvals.
- **Actual request body**: inspect the messages, images, and tool declarations sent to the model instead of guessing at prompt problems.
- **Usage statistics**: tokens, cache hits, cost, and usage time at a glance. Prompt prefixes stay stable, so long conversations keep hitting the cache.

### And more

| Capability | Details |
| --- | --- |
| Model providers | Gemini, OpenAI Chat Completions-compatible APIs, OpenAI Responses, and Anthropic, plus ChatGPT subscription sign-in. Each provider has its own tool mode, reasoning, retry, and token counting settings |
| MCP · Skills · Subagents | Connect MCP servers, load reusable Skills, and dispatch foreground or background subagents for wide reviews and research |
| External coding agents | Attach terminal coding agents such as Kimi Code and Claude Code through ACP |
| Persistent memory | Long-term facts and engineering logs are stored in separate layers, isolated between global and workspace scopes, with migration from systems such as LifeBook |
| Automations | Scheduled or event-triggered tasks whose background results flow back into the original conversation |
| Office files | Read, create, and edit Word, Excel, and PowerPoint files |
| Image tools | Generate, cut out, crop, resize, and rotate images. DeepSeek vision models can use PDF rasterization, GIF frame extraction, and format normalization |
| Characters and companions | Character cards, worldbooks, and regex rules; Live2D desktop pets and screen awareness |
| Devices and Web | Pair several devices for remote execution, or open the Web workspace in a browser |

## Quick Start

1. Download the Windows desktop edition from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases). Run the installer, or extract the full portable archive and open `GrayCode.exe`.
2. Go to **Settings → Channels** and add your Gemini, OpenAI Compatible, OpenAI Responses, or Anthropic channel.
3. Return to chat, pick a channel, model, and Code / Design / Plan / Ask / Review mode, then describe the task.

Try one of these prompts:

> Read this project's structure, explain the main modules, and suggest where to start.

> Find the cause of this exception. Search the related code and show the evidence first, then make and test the change after we agree on the approach.

## Manual

The full manual is maintained with the source in [wiki/](wiki/Home.md) (Chinese):

| Topic | Contents |
| --- | --- |
| [Getting Started](wiki/Getting-Started.md) | Installation, data directories, channels, and the first task |
| [Models, Images, and Context](wiki/Models-and-Context.md) | Protocols, prompt caching, context injection, and vision preprocessing |
| [ChatGPT Subscription](wiki/ChatGPT-Subscription.md) | Browser sign-in, account and workspace switching, automatic renewal |
| [Coding, Review, and Worktrees](wiki/Coding-and-Worktrees.md) | Workspaces, code edits, diff review, Git worktrees, and branching conversations |
| [Office Files](wiki/Office.md) | Read, create, and edit Word, Excel, and PowerPoint |
| [Tools, Skills, and Agents](wiki/Agents-and-MCP.md) | MCP, Skills, subagents, and external ACP agents |
| [Visual Tools](wiki/Visual-Tools.md) | Computer use, the built-in browser, and image tools |
| [Automations, Bots, and Devices](wiki/Automation-and-Devices.md) | Automations, Discord and QQ bots, multiple devices, and the Web workspace |
| [Memory and Companions](wiki/Memory-and-Companions.md) | Long-term memory, engineering logs, Live2D pets, and screen awareness |
| [Characters and Worldbooks](wiki/Characters-and-Worldbooks.md) | Character binding, worldbook budgets, and activation |
| [Data and Diagnostics](wiki/Data-and-Diagnostics.md) | Storage, backup and restore, run history, and troubleshooting |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment, checks, and packaging, [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for architecture and dependency boundaries, and [apps/server/WEB.md](apps/server/WEB.md) for the Web entry. The screenshots in the READMEs and the manual are generated by `scripts/capture-readme-screenshots.cjs`, which replays demo tasks in an isolated environment; rerun it after interface changes.

The 1.x VS Code extension source, installation, and development notes remain on the [`v1-extension`](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension) branch. `main` focuses on the standalone desktop and Web platform.

## Community

- Report issues or suggest ideas through [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues).
- Pull requests are welcome. Please read the [contributing guide](CONTRIBUTING.md) first.

## Acknowledgements

Thanks to [1b0t3](https://github.com/1b0t3), [czocelot](https://github.com/czocelot), and [NebulaRaven](https://github.com/NebulaRaven) for their help with model resources, icons, testing, troubleshooting, fixes, and project collaboration.

## License

GrayCode is licensed under **AGPL-3.0-only with a limited Cubism combination exception**. See [LICENSING.md](LICENSING.md) for the migration scope, historical MIT rights, third-party licenses, and corresponding source delivery. Commercial use and charging must comply with the applicable source and license requirements.
