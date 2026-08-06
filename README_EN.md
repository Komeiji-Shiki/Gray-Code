# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>AI coding assistant: VS Code extension + standalone desktop app (portable)</strong>
</p>

<p align="center">
  Multi-provider models · Tool calling · MCP · Design / Plan / Review workflows · Permanent memory · Multimodal context
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README_EN.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://github.com/czocelot/Gray-Code-Desktop/stargazers"><img src="https://img.shields.io/github/stars/czocelot/Gray-Code-Desktop?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="https://github.com/czocelot/Gray-Code-Desktop/releases"><img src="https://img.shields.io/github/v/release/czocelot/Gray-Code-Desktop?style=flat-square&logo=github" alt="Latest Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/czocelot/Gray-Code-Desktop?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.84.0-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white" alt="VS Code ^1.84.0" />
</p>

> 🚀 **GrayCode Desktop (standalone)** — no VS Code installation needed, works out of the box (Windows / macOS / Linux).
>
> Latest downloads ([Releases](https://github.com/czocelot/Gray-Code-Desktop/releases)):
> [Installer](https://github.com/czocelot/Gray-Code-Desktop/releases/latest) · [Portable](https://github.com/czocelot/Gray-Code-Desktop/releases/latest) · [Zip](https://github.com/czocelot/Gray-Code-Desktop/releases/latest)
>
> This repository also maintains the VS Code extension forked from [Komeiji-Shiki/Gray-Code](https://github.com/Komeiji-Shiki/Gray-Code). The desktop app and the extension share the same backend / frontend / webview code.

---

## Table of Contents

- [Changelog](CHANGELOG.md)
- [About GrayCode](#about-graycode)
- [Core Capabilities](#core-capabilities)
- [Quick Start](#quick-start)
- [Model Channel Configuration](#model-channel-configuration)
- [Common Workflows](#common-workflows)
- [Built-in Tools](#built-in-tools)
- [Settings Pages](#settings-pages)
- [Context and Prompts](#context-and-prompts)
- [MCP, Skills, and Sub-Agents](#mcp-skills-and-sub-agents)
- [Data Storage and Sync](#data-storage-and-sync)
- [Installation and Updates (desktop download / version update)](#installation-and-updates)
- [Local Development](#local-development)
- [Project Structure](#project-structure)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## About GrayCode

GrayCode is an AI coding assistant that runs inside VS Code. It can understand your current workspace, read and edit files, search code, execute commands, inspect symbols and references, manage task plans, and connect to external tools through MCP. Use it to explore unfamiliar projects, explain module relationships, locate bugs, or edit code and review every change through VS Code diff previews before accepting or rejecting it.

For larger work, GrayCode can turn requirements into a design document, generate an execution plan, implement the confirmed plan, and finally produce a structured review record. In long conversations, it can summarize context automatically according to your settings. MCP, Skills, and Sub-Agents extend specialized capabilities, while permanent memory allows the assistant to retain project conventions, design decisions, and personal preferences across sessions and restore relevant context when a new session starts.

## Core Capabilities

**Multi-provider model support** — GrayCode supports Gemini, OpenAI Compatible, OpenAI Responses, and Anthropic channels. Gemini supports native function calling, multimodal input, thinking configuration, and image history limits. OpenAI Compatible works with OpenAI Chat Completions and compatible gateways such as DeepSeek and other relay or gateway services. OpenAI Responses supports `/v1/responses`-style requests, Responses tool calls, and token counting. Anthropic supports Claude tool use, extended thinking, and prompt caching. Each channel can independently configure models, API URL, API key, tool mode, streaming, timeout, retries, custom headers, custom request body, context thresholds, and token counting.

**Tool calling and code operations** — The assistant can call built-in tools to perform real work: read and write files, create directories, delete files, modify code with structured replacements or line insertion and deletion, search file names and content, execute terminal commands, inspect code with VS Code language services, generate and process images, maintain Design / Plan / Review / Progress documents, manage TODO lists, search conversation history, and show Windows notifications. Tool names and descriptions in the settings page follow the interface language (Chinese, English, and Japanese), while model-facing tool names remain stable, such as `read_file` and `apply_diff`.

Invalid argument types sent by a model are corrected when possible, such as the string `"true"` becoming a boolean or a stringified array becoming an array. Unknown arguments are stripped and returned with a warning instead of failing the entire call. Adjacent read-only built-in tools in the same batch are executed in parallel to reduce latency. If the same arguments fail twice in a row, the third identical call is short-circuited with guidance to try a different approach. File paths in tool results are clickable; insert and delete operations also jump to and highlight the affected lines. Sensitive tools can require manual confirmation, and file modifications normally appear as diff previews so you can inspect them before accepting.

**Design, plan, and review workflows** — GrayCode includes document tools for complex tasks. Design records requirements, constraints, options, interfaces, and risks in `.graycode/design/**.md`. Plan breaks a confirmed design into executable steps and TODO items in `.graycode/plans/**.md`. Progress maintains the project ledger in `.graycode/progress.md`, including phase, risks, milestones, and next actions. Review records the review process, evidence, findings, and conclusions in `.graycode/review/**.md`. This workflow is useful for long-running tasks and collaborative work because important state is not lost in a long chat.

**Context awareness** — Depending on your settings, GrayCode can send workspace file trees, open tabs, the active editor, VS Code diagnostics, pinned files and directories, referenced or dragged files and folders, selected code, current time, system environment, workspace paths, and other dynamic information to the model. It also supports both single-use dynamic context and preserved dynamic context policies for tasks that reference the same files over many turns.

💡 **Recommended setting:** If you often work through many consecutive turns, set the dynamic context policy to “Preserve previous dynamic context in place” in Settings → Prompts. A stable request prefix improves the hit rate of Anthropic Prompt Caching, DeepSeek KVCache, and similar provider-side caches. See “Dynamic Context Policies” below for details.

**Multimodal input and attachments** — The input box accepts files, images, audio, video, documents, and other attachments. Text attachments are decoded as text blocks according to their MIME type. PDFs become `input_file` for OpenAI Responses and document blocks for Anthropic. OpenAI Chat Completions can enable `pdfAttachmentEnabled` in channel settings to send PDFs as file content blocks. `read_file` can read images and PDFs when the selected model and channel support them. Dragging a non-text workspace file into the input box sends it as an attachment and structured context instead of incorrectly parsing it as text.

**MCP extensions** — GrayCode supports the Model Context Protocol and can connect to external MCP servers over stdio, SSE, or streamable HTTP. Connected MCP tools are exposed to the model together with built-in tools.

**Skills and Sub-Agents** — Skills are user-defined knowledge modules loaded on demand with `read_skill`. Sub-Agents are configurable specialized agents with limited tool sets and prompts, allowing focused subtasks inside larger tasks. Sub-Agents can nest (depth limit 2, inheriting parent tool filtering), run in the foreground or background (background runs are managed from the task bar, and their completion cards support collapsed / medium / fully expanded views), and communicate with each other and with the main conversation through `agent_send_message` (an inbox mechanism injected with the latest tool result). Sending a new message while a foreground Sub-Agent is running automatically detaches it to the background so it keeps working. The Sub-Agent settings let you configure default iteration and runtime limits (per-agent overrides are supported).

**Permanent memory (OptMem)** — GrayCode includes the OptMem permanent memory system. The default prompt asks the assistant to call `memory_wake` at the beginning of a new session to restore conventions, decisions, and knowledge, and to use `memory_note` for information worth retaining long term. Older memories are compressed into one-line summaries through a binary-tree structure to reduce token usage while preserving important details. `memory_recall` supports regular-expression search across all memories, and `memory_zoom` expands tree nodes layer by layer.

Memory data is stored locally as append-only logs and fixed-width records, without any external service. Settings → Memory allows you to customize the memory prompt, use the `{{$MEMORY}}` template variable, view and edit raw memory entries (add new ones manually as with `memory_note`, or delete a single entry — following entries are renumbered and related summaries are cleared), and adjust runtime parameters such as `wakeLines`, `entryChars`, `partChars`, and `partLines`. Memory tools are disabled for Sub-Agents to prevent duplicate or incorrect memory writes.

**Conversation and experience** — GrayCode supports multiple conversation tabs, automatic history persistence, history viewing and migration, message queuing while the assistant is busy, visible tool states, token usage, thinking content, response timing, automatic checkpoints, sound alerts, Windows notifications, Chinese / English / Japanese interfaces, usage statistics, cost estimation, and Mermaid rendering. Usage statistics aggregate token usage by conversation, model, and day, with bar charts, cache-write / cache-hit dimensions, and cost estimation; the token usage covers all branches, including inactive candidates.

**Streaming rendering experience** — AI output is rendered through a refined streaming pipeline: smooth output types characters at an adaptive rate (speed up when backlogged, slow down gracefully when the provider stalls; adjustable in Appearance: off / smooth / balanced / silky), a character-level fade-in pipeline produces a continuous stream of characters at high token rates, and settled paragraphs are promoted to Markdown rendering immediately instead of waiting for the whole response. Long code blocks stay expanded during streaming and keep their expanded state after it ends. A real-time TPS visualization bar at the bottom of the input area shows the current generation speed (EMA-smoothed, toggleable). A splash animation draws the Gray logo on startup (toggleable).

**Branching conversations** — Rerolling and editing user messages no longer destroys history: the previous answer is kept as a candidate branch under the same parent node (up to 10 candidates), switchable with the candidate switcher (‹ 2/3 ›) and the branch tree panel, which supports renaming, soft deletion (recoverable, default 30-day retention), and one-click cleanup. The branch tree panel has two modes: Branch Navigation (collapses linear segments, keeping branch points) and Full Message Graph (track-style layout showing all nodes). Editing a user message can use “Keep current branch” (in-place save) — only the target message text changes, leaving subsequent messages, checkpoints, and branches intact without regenerating. Branch switching can optionally restore workspace checkpoints together with the chat, guarding unsaved files with confirmation first; checkpoints and branch nodes are bidirectionally linked.

**Usage time statistics** — GrayCode automatically tracks your IDE active time: a 60-second heartbeat plus user activity events (editing, cursor movement, scrolling, editor switching, terminal, and window focus) mark active periods, pausing after 5 minutes of inactivity; AI working sessions (streaming generation, tool execution, sub-agent generation, background tasks) also count as active. The Usage Time section in the usage statistics page and Settings → Usage shows today's usage, the current continuous working session, and the total within the selected range, a daily bar chart for the last 7/30 days, monthly aggregation for 90 days and beyond (click a month to expand daily details), and a 7-day × 24-hour activity heatmap (hover to see active minutes per hour), with range switching among 7 days / 30 days / 90 days / 1 year / all. The assistant can also query your usage statistics via the `get_activity_stats` tool to understand your work-rest rhythm. The data contains timestamps only, is stored fully locally, and never includes conversation content.

## Quick Start

> 💡 **Desktop app users:** After launching GrayCode Desktop you land directly on the chat page; the steps below are identical to the extension.

1. **Install and open the chat panel** — After installing the extension, click the Gray Code icon in the VS Code Activity Bar, or run `GrayCode: Open Chat Panel` from the Command Palette.
2. **Create and configure a channel** — Open Settings → Channels from the top-right of the chat panel, create a channel, choose a channel type (Gemini, OpenAI Compatible, OpenAI Responses, or Anthropic), enter the API URL and API key, add or fetch models, and select a default model. Enable streaming, tool mode, thinking options, retries, and other advanced options as needed.
3. **Choose conversation settings** — Return to the chat page and select the channel, model, and prompt mode (Code / Design / Plan / Ask / Review) at the bottom of the input box.
4. **Start chatting** — Describe the task and send it.

For a first try, ask: “Read this project’s structure, explain what the main modules do, and give me onboarding suggestions.” Or: “Help me find why a feature is misbehaving. Search the relevant code first, explain the cause, and wait for confirmation before modifying it.”

## Model Channel Configuration

All channels support API URL / API key, model lists, tool mode, streaming, timeout, retries, custom headers, custom request bodies, context thresholds, and token counting. Tool modes include `function_call`, `xml`, and `json`, allowing you to choose between native tool calling and prompt-based protocols depending on model compatibility.

**Gemini** commonly uses API URL, API key, optional `Authorization: Bearer`, temperature, `maxOutputTokens`, thinking configuration, thinking visibility, and a history image limit to prevent oversized multimodal histories.

**OpenAI Compatible** is intended for OpenAI Chat Completions and compatible services, including third-party relays, self-hosted gateways, and OpenAI-format model providers. Common options include temperature, `max_tokens`, `top_p`, frequency and presence penalties, reasoning options, custom headers and body fields, and the DeepSeek `user_id` switch.

**OpenAI Responses** is intended for the Responses API. It uses `input`, `instructions`, and output-style structures. Common options include API base URL, `max_output_tokens`, `top_p`, temperature, reasoning options, and Responses token counting.

**Anthropic** is intended for the Claude API. Common options include API URL / API key, optional bearer authentication, temperature, `max_tokens`, `top_p`, `top_k`, extended thinking, prompt caching, cache TTL, cache keep-alive, thinking visibility, and thinking effort levels.

## Common Workflows

**Ask the assistant to edit code** — Describe the feature or bug, ask the assistant to inspect related files and explain the plan first, review the generated diff in VS Code, accept or reject the changes, and then run relevant tests.

Suggested prompt: “Locate the relevant code and explain your plan first. Do not modify files until I confirm. Run related tests after the change.”

**Complex requirements: Design → Plan → Implement** — Use Design mode to produce a design document, Plan mode to split the confirmed design into executable steps and TODO items, Code mode to implement them, and Review mode to audit the result.

**Ask questions without modifying code** — Switch to Ask mode, or explicitly say: “Only analyze and explain. Do not modify files or execute commands.”

**Review existing changes** — Switch to Review mode and ask: “Review the current workspace changes, focusing on correctness, edge cases, test coverage, and maintainability. Produce a structured review document.”

**Keep long conversations usable** — Enable automatic summarization, manually ask for a summary when needed, use Plan / Progress documents to preserve task state, and use preserved dynamic context when important context must stay fixed across turns.

## Built-in Tools

Tool availability depends on settings, dependencies, channel capabilities, and workspace permission policies.

| Category | Tools | Description |
| --- | --- | --- |
| File tools | read_file, write_file, list_files, delete_file, create_directory, apply_diff, insert_code, delete_code | Read single files with `path` or multiple files with `files`; optional line ranges; multimodal image / PDF reading; write files, manage directories, apply structured replacements, and insert or delete lines with diff previews |
| Search tools | find_files, search_in_files | Glob-based file discovery and content search or replacement with regular expressions and context previews |
| Terminal tools | execute_command | Execute shell commands through PowerShell, CMD, Bash, Git Bash, WSL, and other available shells |
| LSP code intelligence | get_symbols, goto_definition, find_references | Inspect symbols, jump to definitions, and find references |
| Media tools | generate_image, remove_background, crop_image, resize_image, rotate_image | Generate images and remove backgrounds, crop, resize, or rotate images |
| Tasks and documents | todo_write, todo_update, create_design / update_design, create_plan / update_plan, create_progress / update_progress, record_progress_milestone, validate_progress_document, create_review, record_review_milestone, finalize_review, validate_review_document, reopen_review, compare_review_documents | Manage TODO lists and Design / Plan / Progress / Review documents |
| Sub-Agents | subagents | Delegate work to specialized agents in the foreground or background, continue from `continueFromRunId`, and inspect runs in SubAgent Monitor |
| History, skills, notifications | history_search, read_skill, show_windows_notification | Search conversation history, load Skill content, and show Windows notifications |
| Usage time | get_activity_stats | Query IDE usage time statistics (daily usage minutes, recent schedule heatmap, continuous working duration); timestamps only |
| Memory | memory_wake, memory_note, memory_recall, memory_compress, memory_zoom, memory_forget, memory_config | OptMem permanent memory: wake, record, search, compress, expand, discard summaries or delete single/closed-range entries, and configure |

## Settings Pages

The settings page includes Channels, Tools, Auto Execution, MCP, Checkpoints, Summarization, Image Generation, Dependencies, Context, Prompts, Token Counting, Sub-Agents, Sound, Appearance, Usage, Memory, and General settings. Appearance covers interface language, loading text, splash animation, the TPS bar, and the smooth-streaming level. Checkpoints include four-layer exclusion rules with a preview. Usage embeds the Usage Time section and a token usage summary card with a full statistics page entry.

Channels manage model providers and API parameters. Tools control whether individual tools are enabled and how they behave. Auto Execution decides which tools require confirmation. MCP manages external servers. Checkpoints configure recovery points. Summarization controls automatic context summaries. Context controls which workspace information can be injected. Prompts manage modes, templates, prompt entries, dynamic context policies, template variables, and mode-level tool policies. Memory configures OptMem and custom memory instructions. General settings include proxy, storage path migration, and settings import / export.

## Context and Prompts

**Prompt modes** — GrayCode includes five built-in modes: Code for normal coding and file edits, Design for requirement analysis and design documents, Plan for task breakdown and execution plans, Ask for question answering without modifications, and Review for code review records. You can modify, duplicate, delete, or add modes in Settings → Prompts.

Each mode can independently configure its assembly method, static system prompt, dynamic context template, dynamic context retention policy, and mode-level tool policy. Mode-level tool policies can inherit the default tool set or allow only selected tools.

**Legacy templates and prompt entries** — Legacy templates are suitable for simple prompts that need one system prompt and one dynamic context template. Prompt Entries provide finer control over the order of system, user, and assistant context, and include a Chat History entry that marks where the real conversation history should be inserted.

Prompt entries can be reordered, enabled or disabled, duplicated, and converted from legacy templates. System entries are merged into the system prompt. User entries are temporary user context and are not saved as real history. Assistant entries are temporary assistant examples and are also not saved as real history. The position of Chat History determines whether preset constraints appear before, after, or around the real conversation history.

**Dynamic context policies** — Dynamic context is generated for each request and normally is not written into real history. The `single` policy inserts only the latest dynamic context, which is suitable for normal conversations. The `preserve` policy keeps previous dynamic context in its original position where possible, keeping request prefixes stable and improving provider-side cache hit rates. `preserve` is useful for long, multi-turn implementation or review work, but it increases historical token pressure. You can switch back to `single` or enable automatic summarization if context becomes too long.

**Context awareness settings** — Settings → Context controls which information can become dynamic context: workspace file tree, maximum tree depth, open tabs, active editor path, VS Code diagnostics, severity and count limits, and custom ignore patterns for files such as dependencies, logs, and build output.

**Template variables** — System prompts, dynamic context templates, and prompt entries support variables in the form `{{$VARIABLE}}`. Common static variables include `{{$ENVIRONMENT}}`, `{{$CONTEXT_BADGE_FORMAT}}`, `{{$TOOLS}}`, `{{$MCP_TOOLS}}`, and `{{$MEMORY}}`. Common dynamic variables include `{{$TODO_LIST}}`, `{{$WORKSPACE_FILES}}`, `{{$OPEN_TABS}}`, `{{$ACTIVE_EDITOR}}`, `{{$DIAGNOSTICS}}`, `{{$PINNED_FILES}}`, and `{{$SKILLS}}`.

**Pinned files and context badges** — The input area supports context badges for files or directories, selected code, attachments, pinned files, and Skills. These badges tell the model exactly what to focus on in the current turn.

## MCP, Skills, and Sub-Agents

**MCP** — Add servers in Settings → MCP. stdio servers require command, arguments, and environment variables; SSE servers require an SSE URL and headers; streamable HTTP servers require an HTTP URL and headers. Connected server tools are exposed to the model. Schema cleanup can be enabled for models that are strict about JSON Schema fields.

**Skills** — Skills are reusable knowledge modules for project conventions, commit rules, troubleshooting guides, framework knowledge, or domain-specific instructions. Enabled Skills appear in the available list, and the assistant loads their complete content with `read_skill` when needed.

**Sub-Agents** — Sub-Agents divide work between specialized roles such as test analysis, documentation, security review, or frontend styling. Each agent can have its own prompt and allowed tools. Memory tools are excluded from Sub-Agents to prevent duplicate or incorrect cross-session memory writes. The main model can pass `continueFromRunId` to continue a new agent run from a completed previous run.

**SubAgent Monitor** — The independent SubAgent Monitor panel shows and manages agent runs in real time. It supports multiple run tabs, automatic output following, pause / resume / exit controls, read-only historical runs, loading older transcript messages, and compact result cards in the main chat for background runs.

## Data Storage and Sync

**VS Code Settings Sync** — Most settings are stored under the `graycode.*` VS Code settings namespace and can sync through VS Code Settings Sync, including tool switches, auto-execution policies, prompt configuration, UI preferences, token counting, and image tool configuration. Machine-level settings are excluded from sync: `graycode.proxy`, `graycode.storagePath`, and `graycode.activeChannelId`.

**Custom storage path** — Configure and migrate the data storage path in Settings → General. Reload the window after migration.

**Legacy migration** — When upgrading from older versions, GrayCode attempts to migrate the legacy `globalStorage/settings/settings.json` into VS Code settings and backs up the old file as `settings.json.bak`.

**Settings import and export** — Settings → General can export channel configuration, MCP servers, Skills, and VS Code settings to JSON, or import them from a file. Import supports both skipping existing items and overwriting all items. Export does not include conversation history, checkpoints, raw permanent-memory data, or workspace files. You can also run `GrayCode: Export Settings` and `GrayCode: Import Settings` from the Command Palette.

## Installation and Updates

### GrayCode Desktop (standalone, recommended)

No VS Code installation needed — ships with a built-in `vscode-shim` compat layer, feature-identical to the extension (Windows x64 / macOS / Linux).

**First install**

- **Installer**: download `GrayCode.Setup.<version>.exe` and run it; the install directory can be customized
- **Portable**: download `GrayCode-Portable-<version>.exe` and double-click to run; or download `GrayCode-<version>-win.zip` and run `GrayCode.exe` after extraction
- Data is stored in a `data/` folder next to the program by default (delete the folder to fully uninstall); use `--user-data-dir <path>` or the `GRAYCODE_USER_DATA_DIR` environment variable to override
- The packages are not code-signed; the SmartScreen / OS security prompt on first launch is expected — choose "Run anyway"

**Updating (desktop app users)**

- **Installer**: download and run the new installer — settings and conversation data are kept
- **Portable**: download the new exe / zip and replace the old program files; the `data/` folder is preserved
- Before upgrading, you can back up the `data/` folder or use Settings → General → Export Settings
- Downloads: [GitHub Releases](https://github.com/czocelot/Gray-Code-Desktop/releases)

### VS Code extension

VS Code `^1.84.0` or newer is required. Node.js 20 or newer is recommended for source builds and VSIX packaging. This extension is not published to the VS Code Marketplace; install it from a VSIX package or from source.

**Install from VSIX** — Download a `graycode-*.vsix` file from [GitHub Releases](https://github.com/czocelot/Gray-Code-Desktop/releases), or build one locally. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run `Extensions: Install from VSIX...`, and select the VSIX file.

**Build and install from source** — This repository uses npm and commits `package-lock.json`:

```bash
# Clone the repository
git clone https://github.com/czocelot/Gray-Code-Desktop.git
cd Gray-Code-Desktop

# Install root dependencies
npm ci

# Install frontend dependencies
npm --prefix frontend ci

# Full build
npm run build

# Package the VSIX
npx @vscode/vsce package
```

### Maintainers: releasing a new version / syncing upstream

This repository is a fork of [Komeiji-Shiki/Gray-Code](https://github.com/Komeiji-Shiki/Gray-Code). The full release workflow:

1. **Sync upstream**: `git fetch upstream && git merge upstream/main`; when resolving conflicts, keep this fork's increments (`electron-app` / diff & code viewer panels / safety guards), following the existing `merge: 合入上游 vX.Y.Z` commits as reference
2. **Bump versions**: update `version` in the root `package.json` and `electron-app/package.json`
3. **Update changelogs**: add entries for the new version in the root `CHANGELOG.md` and `electron-app/CHANGELOG.md`
4. **Verify**: `npm run typecheck`, `npm test`, `npm --prefix frontend run test`, `npm run build` (extension build); `npm --prefix electron-app run e2e` (desktop end-to-end regression)
5. **Package the desktop app**: `npm --prefix electron-app run dist:win` — artifacts land in `electron-app/release/` (installer / portable / zip; use `dist:mac` / `dist:linux` for other platforms)
6. **Tag and publish**: `git tag v<version> && git push origin v<version>`, then create the release on GitHub Releases, fill in the notes and upload the artifacts from `electron-app/release/`
7. **(Optional) Push back upstream**: open a Pull Request from this repository to upstream — complete step 1 first so the fork is in sync and conflict-free

## Local Development

**Recommended: VS Code debug configuration** — Open this repository and choose `Run Extension (Local Vite Dev)` in Run and Debug. It starts the backend esbuild watcher, starts the frontend Vite dev server on port 5173, and sets `GRAYCODE_WEBVIEW_DEV_SERVER_URL=http://127.0.0.1:5173` so the webview loads local frontend resources. The Vite dev server is only used in extension development mode; production builds use `frontend/dist`.

**Manual startup** — Run `npm run watch` in terminal A, run `npm run dev:frontend` in terminal B, then use the normal `Run Extension` configuration or a custom configuration with `GRAYCODE_WEBVIEW_DEV_SERVER_URL`.

**Common scripts** — `npm run compile` bundles the extension backend with esbuild. `npm run typecheck` runs TypeScript checks. `npm run watch` starts esbuild watch mode. `npm run build:frontend` builds the webview frontend. `npm run dev:frontend` starts the local frontend server. `npm run build` builds backend and frontend. `npm test` runs backend Jest tests. `npm run test:frontend` runs frontend Vitest tests. `npm run test:coverage` generates backend coverage.

## Project Structure

```text
Gray-Code/
├── backend/                 # Extension backend capabilities
│   ├── __tests__/           # Backend Jest regression tests
│   ├── core/                # Core context, logging, and shared services
│   ├── modules/             # Channels, configuration, conversations, MCP, prompts, settings, and other modules
│   └── tools/               # Built-in tool implementations
├── electron-app/            # GrayCode Desktop (Electron, built-in vscode-shim)
├── frontend/                # Vue 3 + Pinia + Vite webview frontend
│   ├── src/__tests__/       # Frontend Vitest tests
│   ├── src/components/      # Chat, input, settings, and other components
│   ├── src/stores/          # State management
│   └── src/services/        # Frontend services
├── test/                    # Cross-module and frontend utility tests
├── webview/                 # VS Code webview routing and message handlers
├── resources/               # Icons, fonts, sounds, and other resources
├── fast-tavern-main/        # Bundled Fast Tavern-related subprojects
├── extension.ts             # VS Code extension entry point
├── index.ts                 # Backend module export entry
├── package.json             # Extension manifest, commands, configuration, and scripts
├── README.md                # Chinese documentation
└── README_EN.md             # English documentation
```

## FAQ

**Why is the assistant not calling tools?** Check whether tools are enabled for the current channel, whether the tool mode is compatible with the model, whether the tool is enabled in Settings → Tools, whether dependencies are installed, and whether the current prompt mode restricts tools.

**Why does a tool require confirmation?** Settings → Auto Execution controls which tools run automatically. Sensitive operations such as deleting files, executing commands, and writing outside the workspace should normally keep confirmation enabled.

**Why did reading a file outside the workspace fail?** `read_file` and `write_file` have separate access policies for paths outside the workspace. Expand the corresponding tool in Settings → Tools to change its policy.

**How can `read_file` read multiple files at once?** Use `path`, `startLine`, and `endLine` for a single file. Use `files: [{ path, startLine?, endLine? }]` for batch reading. Do not mix `path` and `files` in the same call.

**Why is the model context too long?** Enable automatic summarization, lower the context threshold, reduce dynamic context such as file trees, open tabs, and diagnostics, reduce pinned files, or set a Gemini image history limit.

**Where do I accept a diff?** When a tool creates a file modification, VS Code opens a diff preview. Use the editor title actions or keyboard shortcuts: accept the current block (`Ctrl+Shift+Y` / `Cmd+Shift+Y` on macOS), reject the current block (`Ctrl+Shift+N` / `Cmd+Shift+N` on macOS), go to the next block (`Alt+]`), or go to the previous block (`Alt+[`). Commands are also available: `GrayCode: Accept All Changes`, `GrayCode: Reject All Changes`, `GrayCode: Accept Diff Block...`, and `GrayCode: Reject Diff Block...`.

**Why do Windows notifications or sounds not appear?** Check whether the corresponding event is enabled in Settings → Sound, whether Windows allows VS Code notifications, and whether the webview has been allowed to play audio by the browser policy.

## Contributing

Issues and pull requests are welcome through [GitHub Issues](https://github.com/czocelot/Gray-Code-Desktop/issues). Before submitting, run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:frontend` to make sure type checking, backend and frontend builds, and both test suites pass. If your change affects frontend interaction, also verify the local webview development mode.

## License

This project is licensed under the [MIT License](LICENSE).
