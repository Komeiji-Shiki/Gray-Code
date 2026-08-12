# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>An AI coding assistant extension for VS Code</strong>
</p>

<p align="center">
  Multi-provider models · Tool calling · MCP · Design / Plan / Review workflows · Permanent memory · Multimodal context
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README_EN.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><img src="https://img.shields.io/github/v/release/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="Latest Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Komeiji-Shiki/Gray-Code?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.84.0-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white" alt="VS Code ^1.84.0" />
</p>

---

## Table of Contents

- [Changelog](CHANGELOG.md)
- [About GrayCode](#about-graycode)
- [Quick Start](#quick-start)
- [Core Capabilities](#core-capabilities)
- [Model Channel Configuration](#model-channel-configuration)
- [Common Workflows](#common-workflows)
- [Built-in Tools](#built-in-tools)
- [Settings Pages](#settings-pages)
- [Context and Prompts](#context-and-prompts)
- [MCP, Skills, and Sub-Agents](#mcp-skills-and-sub-agents)
- [Data Storage and Sync](#data-storage-and-sync)
- [Installation and Updates](#installation-and-updates)
- [Local Development](#local-development)
- [Project Structure](#project-structure)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Related Projects](#related-projects)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## About GrayCode

GrayCode is an AI coding assistant that runs inside VS Code. It can understand your current workspace, read and edit files, search code, execute commands, inspect symbols and references, manage task plans, and connect to external tools through MCP.

Use it to explore unfamiliar projects, explain module relationships, locate bugs, or edit code and review every change through VS Code diff previews before accepting or rejecting it.

You can also turn requirements into a design document, generate an execution plan, implement the confirmed plan, and review existing changes with a structured review record. In long conversations, it can summarize context automatically according to your settings to reduce repetitive explanations.

MCP, Skills, and Sub-Agents extend specialized capabilities, while permanent memory allows the assistant to retain project conventions, design decisions, and personal preferences across sessions and restore relevant context when a new session starts.

## Quick Start

1. **Install the extension** — GrayCode is now published on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode); search for "Gray Code" in the Extensions view to install it directly. You can also install it from a VSIX package:
   - Download the `graycode-*.vsix` file for your version from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) (you can also build one locally; see “Installation and Updates”).
   - Open VS Code, open the Command Palette with `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`), run `Extensions: Install from VSIX...`, and select the downloaded VSIX file in the file picker. Wait for the installation to finish.
   - Alternatively, click the Extensions icon in the Activity Bar (`Ctrl+Shift+X`), open the `...` menu at the top-right of the Extensions view, choose `Install from VSIX...`, and select the VSIX file.
   - After installation, find GrayCode in the Extensions list and make sure it is enabled.
2. **Open the chat panel** — Click the Gray Code icon in the VS Code Activity Bar, or run `GrayCode: Open Chat Panel` from the Command Palette.
3. **Create and configure a channel** — Open Settings → Channels from the top-right of the chat panel, create a channel, choose a channel type (Gemini, OpenAI Compatible, OpenAI Responses, or Anthropic), enter the API URL and API key, add or fetch models, and select a default model. Enable streaming, tool mode, thinking options, retries, and other advanced options as needed.
4. **Choose conversation settings** — Return to the chat page and select the channel, model, and prompt mode (Code / Design / Plan / Ask / Review) at the bottom of the input box.
5. **Start chatting** — Describe the task and send it.

For a first try, ask: “Read this project’s structure, explain what the main modules do, and give me onboarding suggestions.” Or: “Help me find why a feature is misbehaving. Search the relevant code first, explain the cause, and wait for confirmation before modifying it.”

## Core Capabilities

**Multi-provider model support** — GrayCode supports the following model channels:

- **Gemini** — Google Gemini API and compatible-format services, with native Function Calling, multimodal input, thinking configuration, image history limits, and more
- **OpenAI Compatible** — OpenAI Chat Completions and compatible interfaces, suitable for OpenAI, DeepSeek, and various relay or compatible services
- **OpenAI Responses** — `/v1/responses`-style requests, supporting Responses tool calls and token counting
- **Anthropic** — Claude API, supporting Claude tool use, extended thinking, and prompt caching

Each channel can independently configure models, API URL, API key, tool mode, streaming, timeout, retries, custom headers, custom request body, context thresholds, and token counting.

**Tool calling and code operations** — The assistant can call built-in tools to perform real work: read and write files, create directories, delete files, modify code with structured replacements or line insertion and deletion, search file names and content, execute terminal commands, inspect code with VS Code language services, generate and process images, maintain Design / Plan / Review / Progress documents, manage TODO lists, search conversation history, and show Windows notifications.

Tool names and descriptions in the settings page follow the interface language (Chinese, English, and Japanese), while model-facing tool names remain stable, such as `read_file` and `apply_diff`.

Invalid argument types sent by a model are corrected when possible, such as the string `"true"` becoming a boolean or a stringified array becoming an array. Unknown arguments are stripped and returned with a warning instead of failing the entire call.

Adjacent read-only built-in tools in the same batch (such as read_file, list_files, find_files, get_symbols, goto_definition, find_references, history_search, read_skill, memory_wake, memory_recall, and memory_zoom) are executed in parallel to reduce the cumulative latency of repeated reads and searches.

If the same arguments fail twice in a row, the third identical call is short-circuited with guidance to try a different approach, avoiding wasted iterations on repeated failures.

File paths in tool results are clickable; insert and delete operations also jump to and highlight the affected lines. Sensitive tools can require manual confirmation, and file modifications normally appear as diff previews so you can inspect them before accepting.

**Design, plan, and review workflows** — GrayCode includes document tools for complex tasks. Design records requirements, constraints, options, interfaces, and risks in `.graycode/design/**.md`. Plan breaks a confirmed design into executable steps and TODO items in `.graycode/plans/**.md`. Progress maintains the project ledger in `.graycode/progress.md`, including phase, risks, milestones, and next actions. Review records the review process, evidence, findings, and conclusions in `.graycode/review/**.md`. This workflow is useful for long-running tasks and collaborative work because important state is not lost in a long chat.

**Context awareness** — Depending on your settings, GrayCode can send workspace file trees, open tabs, the active editor, VS Code diagnostics, pinned files and directories, referenced or dragged files and folders, selected code, current time, system environment, workspace paths, and other dynamic information to the model.

It also supports both single-use dynamic context and preserved dynamic context policies for tasks that reference the same files over many turns.

💡 **Recommended setting:** If you often work through many consecutive turns, set the dynamic context policy to “Preserve previous dynamic context in place” in Settings → Prompts. A stable request prefix improves the hit rate of Anthropic Prompt Caching, DeepSeek KVCache, and similar provider-side caches. See “Dynamic Context Policies” below for details.

**Multimodal input and attachments** — The input box accepts files, images, audio, video, documents, and other attachments. Text attachments are decoded as text blocks according to their MIME type. PDFs become `input_file` for OpenAI Responses and document blocks for Anthropic. OpenAI Chat Completions can enable `pdfAttachmentEnabled` in channel settings to send PDFs as file content blocks. `read_file` can read images and PDFs when the selected model and channel support them. Dragging a non-text workspace file into the input box sends it as an attachment and structured context instead of incorrectly parsing it as text.

**MCP extensions** — GrayCode supports the Model Context Protocol and can connect to external MCP servers over stdio, SSE, or streamable HTTP. Connected MCP tools are exposed to the model together with built-in tools.

**Skills and Sub-Agents** — Skills are user-defined knowledge modules loaded on demand with `read_skill`. Sub-Agents are configurable specialized agents with limited tool sets and prompts, allowing focused subtasks inside larger tasks.

**Permanent memory (OptMem)** — GrayCode includes the OptMem permanent memory system. The default prompt asks the assistant to call `memory_wake` at the beginning of a new session to restore conventions, decisions, and knowledge, and to use `memory_note` for information worth retaining long term, such as project conventions, user-taught knowledge, and key decisions.

Memory is split into global memory (shared across all workspaces) and workspace memory (stored separately per workspace); both `memory_wake` and `memory_recall` cover the two scopes. Older memories are compressed into one-line summaries through a binary-tree structure to reduce token usage while preserving important details. `memory_recall` supports regular-expression search across all memories, and `memory_zoom` expands tree nodes layer by layer. Memory data is stored locally as append-only logs and fixed-width records, without any external service.

Settings → Memory lets you customize the memory prompt or fine-tune it through the `{{$MEMORY}}` template variable; actual behavior is also affected by tool enablement, prompt mode, and model tool-calling capability.

Settings → Memory also lets you view and edit all raw memory entries in place (edits automatically clean related tree summaries), manually add new memories (equivalent to `memory_note`), and delete entries one by one or in a multi-select batch (after deletion, entries are renumbered and related summaries are cleared).

You can adjust memory runtime parameters in Settings → Memory: `wakeLines` (wake output lines), `entryChars` (maximum bytes per entry), `partChars` (maximum characters per page), and `partLines` (maximum lines per page).

Memory tools are disabled for Sub-Agents to prevent duplicate or incorrect memory writes.

**Conversation and experience** — Multiple conversation tabs keep several working contexts alive at once. Conversation history is saved automatically and can be viewed, restored, and migrated.

The message queue lets you keep typing while the assistant is busy — queued messages are sent automatically right after the current action finishes, without waiting for the whole run to end; completion receipts from background sub-agents / background commands are likewise inserted as soon as they finish instead of waiting for the model turn to end.

Tool states, token usage, thinking content, time-to-first-token (TTFT), and response timing are visualized. Automatic checkpoints can create recovery points for key messages or tool executions according to policy, and the toolbar at the bottom of the input area also lets you create a manual checkpoint at any time. Sound alerts and Windows notifications help with long tasks and confirmations. The interface supports Chinese, English, and Japanese, with appearance settings.

The usage statistics page aggregates token usage from conversation history across overview, per-conversation, per-model, and per-day dimensions, with bar-chart visualization, cache-write / cache-hit dimensions, cost estimation, and time-range filtering.

Mermaid rendering turns Mermaid syntax in Markdown code blocks into flowcharts, sequence diagrams, and other charts automatically.

**Streaming rendering experience** — AI output is rendered through a refined streaming pipeline: smooth output types characters at an adaptive rate (speed up when backlogged, slow down gracefully when the provider stalls; adjustable in Appearance: off / smooth / balanced / silky), a character-level fade-in pipeline produces a continuous stream of characters at high token rates, and settled paragraphs are promoted to Markdown rendering immediately instead of waiting for the whole response. Long code blocks stay expanded during streaming and keep their expanded state after it ends.

A real-time TPS visualization bar at the bottom of the input area shows the current generation speed (EMA-smoothed, toggleable). A splash animation draws the Gray logo on startup (toggleable).

**Usage time statistics** — GrayCode automatically tracks your IDE active time: a 60-second heartbeat plus user activity events (editing, cursor movement, scrolling, editor switching, terminal, and window focus) mark active periods, pausing after 5 minutes of inactivity; AI working sessions (streaming generation, tool execution, sub-agent generation, background tasks) also count as active.

The Usage Time section in the usage statistics page and Settings → Usage shows today's usage, the current continuous working session, and the total within the selected range, a daily bar chart for the last 7/30 days, monthly aggregation for 90 days and beyond (click a month to expand daily details), and a 7-day × 24-hour activity heatmap (hover to see active minutes per hour), with range switching among 7 days / 30 days / 90 days / 1 year / all.

The assistant can also query your usage statistics via the `get_activity_stats` tool to understand your work-rest rhythm. The data contains timestamps only, is stored fully locally, and never includes conversation content.

**Branching conversations** — Rerolling and editing user messages no longer destroys history: the previous answer is kept as a candidate branch under the same parent node (up to 10 candidates), you can switch between candidates and rebuild the active path, and each candidate can continue into its own sub-branch.

The candidate switcher (‹ 2/3 ›) at the top of the message area and the full branch tree panel support viewing, switching, renaming, and soft-deleting branches (soft deletion is recoverable, with a default 30-day retention and one-click cleanup in settings). The branch tree panel has two modes: Branch Navigation (collapses linear segments, keeping branch points) and Full Message Graph (track-style layout showing all nodes).

Editing a user message can use “Keep current branch” (in-place save) — only the target message text changes, leaving subsequent messages, checkpoints, and branches intact without regenerating. Branch switching restores the chat only by default; when a branch has executed write tools or holds workspace checkpoints, you are prompted whether to restore the workspace checkpoint together (unsaved files are guarded with confirmation first). Checkpoints and branch nodes are bidirectionally linked, and checkpoint cleanup follows reference counting when branches are deleted. Usage statistics cover all branches, including inactive candidates.

**Sub-Agents** — Configurable specialized agents with limited tool sets and prompts:

- Nested dispatch is supported (a Sub-Agent can spawn further Sub-Agents, depth limit 2, inheriting parent permissions)
- Foreground and background modes; background runs are managed from the task bar, and their completion cards support collapsed / medium / fully expanded views
- Sending a new message while a foreground Sub-Agent is running automatically detaches it to the background so it keeps working
- Sub-Agents can communicate with each other and with the main conversation through `agent_send_message` (an inbox mechanism injected with the latest tool result)
- Per-agent settings cover default iteration counts and runtime limits (individual agents can override global defaults)
- A “Sync with current model” switch makes an agent follow the current conversation's channel and model when dispatched, so you don't need to update every agent when switching channels

## Model Channel Configuration

Existing channels can change their type at any time (Gemini / OpenAI Compatible / OpenAI Responses / Anthropic are interchangeable); generic fields (API key, timeout, retries, custom headers/body, etc.) are kept, while type-specific fields are reset to the new type's defaults.

All channels support, fully or partially, the following configuration:

- **Connection** — API URL / API key, model lists (added manually or fetched from the server)
- **Requests** — tool mode (`function_call` uses native tool calling, `xml` injects tool descriptions as XML for models with unstable or missing native support, `json` injects tool descriptions as JSON code blocks), `preferStream` / `stream` controls streaming preference, `timeout` sets the request timeout, and automatic retries (count and interval after failures)
- **Customization** — custom headers (extra request headers for relays or self-hosted services) and custom request bodies (append or override body fields, supporting simple key-value pairs and full JSON)
- **Advanced** — context thresholds (trim or summarize context at a token ratio), strict tools (enforce schema more strictly on supported channels), and token counting (channel default, Gemini countTokens API, custom OpenAI-format counting API, OpenAI Responses, Anthropic count_tokens, or local estimation)

**Gemini** commonly uses API URL, API key, optional `Authorization: Bearer`, temperature, `maxOutputTokens`, thinking configuration, thinking visibility, and a history image limit to prevent oversized multimodal histories.

**OpenAI Compatible** is intended for OpenAI Chat Completions and compatible services, including third-party relays, self-hosted gateways, and OpenAI-format model providers.

Common options include temperature, `max_tokens`, `top_p`, frequency and presence penalties, reasoning options (such as effort and summary), custom headers and body fields for relay-specific parameters, and the DeepSeek `user_id` switch (when enabled, a stable identifier based on the conversation ID isolates DeepSeek KVCache per conversation; off by default to avoid confusing relays or other compatible services).

**OpenAI Responses** is intended for the Responses API. It uses `input`, `instructions`, and output-style structures. Common options include API base URL, `max_output_tokens`, `top_p`, temperature, reasoning options, and Responses token counting.

**Anthropic** is intended for the Claude API.

Common options include API URL / API key, optional bearer authentication, temperature, `max_tokens`, `top_p`, `top_k`, extended thinking (enabled / adaptive / disabled), prompt caching (cache TTL of 5 minutes / 1 hour and a cache keep-alive switch), thinking visibility (hidden / summary), and thinking effort levels (low / medium / high / xhigh / max / ultra, plus a custom level; OpenAI and OpenAI Responses channels support extended effort levels too).

## Common Workflows

**Ask the assistant to edit code** — Describe the feature or bug, ask the assistant to inspect related files and explain the plan first, review the generated diff in VS Code, accept or reject the changes, and then run relevant tests.

Suggested prompt: “Locate the relevant code and explain your plan first. Do not modify files until I confirm. Run related tests after the change.”

**Complex requirements: Design → Plan → Implement** — Use Design mode to produce a design document, Plan mode to split the confirmed design into executable steps and TODO items, Code mode to implement them, and Review mode to audit the result.

**Ask questions without modifying code** — Switch to Ask mode, or explicitly say: “Only analyze and explain. Do not modify files or execute commands.”

**Review existing changes** — Switch to Review mode and ask: “Review the current workspace changes, focusing on correctness, edge cases, test coverage, and maintainability. Produce a structured review document.”

**Keep long conversations usable** — Enable automatic summarization, manually ask for a summary when needed, use Plan / Progress documents to preserve task state, and use preserved dynamic context when important context must stay fixed across turns. Summarized originals are kept in history as marked messages and can be restored at any time; the first user message is always preserved.

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

Open Settings from the top-right of the chat panel to access the following sections; the title bar of the settings page supports keyword search with real-time filtering and jump-to-setting:

- **Channels** — manage model channels, model lists, API parameters, tool modes, retries, custom headers/body, and more
- **Tools** — enable or disable tools, adjust tool configuration, and set the maximum tool calls per turn
- **Auto Execution** — control which tools run automatically and which require manual confirmation
- **MCP** — add, connect, and manage MCP servers
- **Checkpoints** — configure automatic checkpoints, four-layer exclusion rules, and checkpoint cleanup, with an exclusion preview
- **Summarization** — configure automatic summarization thresholds, the summary model, and the summary prompt
- **Image Generation** — configure image generation services and parameters
- **Dependencies** — check and install dependencies for certain tools
- **Context** — control injected context such as file trees, open tabs, diagnostics, and pinned files
- **Prompts** — manage prompt modes, legacy templates, prompt entries, dynamic context templates and policies, template variables, and mode-level tool policies
- **Token Counting** — configure token counting methods for different channels
- **Sub-Agents** — configure specialized agents, tool scopes, and prompts
- **Sound** — configure sounds for task completion, errors, warnings, and more
- **Appearance** — configure interface language, loading text, splash animation, the TPS bar, the smooth-streaming level, selected-code actions, and other UI preferences
- **Usage** — embeds the Usage Time section and a token usage summary card, with a full statistics page entry
- **Memory** — configure OptMem and custom memory instructions
- **General** — proxy, automatic updates (check / one-click update), storage path migration, settings import / export, and other general settings

## Context and Prompts

**Prompt modes** — GrayCode includes five built-in modes: Code for normal coding and file edits, Design for requirement analysis and design documents, Plan for task breakdown and execution plans, Ask for question answering without modifications, and Review for code review records. You can modify, duplicate, delete, or add modes in Settings → Prompts.

Each mode can independently configure its assembly method (legacy template or prompt entries), static system prompt, dynamic context template, dynamic context retention policy, and mode-level tool policy (inherit the default tool set or allow only selected tools). The mode selector at the bottom of the input box uses these modes; saving prompt settings refreshes the mode list.

**Legacy templates and prompt entries** — GrayCode supports two prompt assembly methods:

- **Legacy templates** — suitable for simple configurations needing one system prompt and one dynamic context template; `template` serves as the system prompt, and `dynamicTemplate` is inserted as a temporary dynamic context message
- **Prompt Entries** — suitable for precise control over system/user/assistant context order or for specifying where the real conversation history is inserted; entries are assembled in order, and a Chat History entry marks the insertion point for real history

Legacy templates are the easiest to understand: the system prompt template holds long-term stable rules and role instructions, while the dynamic context template is regenerated per request and never written into real history. If you only want to change the assistant's role, tone, or default behavior, use a legacy template.

Prompt entries act more like a “request skeleton editor”. In Settings → Prompts, switch the assembly method to Prompt Entries to add, duplicate, delete, enable/disable, and drag to reorder entries.

Entries fall into two categories: regular Prompt entries (sent to the model under the chosen role, with content and variables) and the Chat History entry (a fixed insertion point for real conversation history; never sent as a normal message, cannot be deleted or disabled, but can be repositioned).

Regular Prompt entries have three roles: system (merged into the system prompt, typically for global rules, tool descriptions, output formats, and long-term constraints), user (temporary user context inserted into the request and not saved to real history, typically for current task context, file trees, TODO, and supplementary material), and assistant (temporary assistant messages inserted into the request and not saved to real history, typically for example replies, expected format samples, and preset intermediate states).

The position of Chat History matters: after all entries, the model sees preset rules and context before real history; in the middle, it enables “pre-history context → real history → post-history constraints”; before everything, it re-emphasizes strong constraints after real history. Prompt entries can be converted from legacy templates, which helps split one big prompt into maintainable pieces.

**Dynamic context policies** — Dynamic context is “context generated fresh for each request”, such as file trees, open tabs, the active file, diagnostics, TODO, and pinned files. It is normally not written into real history to keep history clean.

GrayCode supports two dynamic context retention policies:

- **single** — inserts only the latest dynamic context each turn; older turns' dynamic context is not replayed, suitable for most normal chats to avoid repeated context consuming tokens
- **preserve** — keeps each turn's cached dynamic context and re-inserts it near its original position where possible; new context goes to the new turn position; a stable request prefix improves LLM prompt-cache hits, suitable for multi-turn editing of the same files, keeping per-turn context in the model's view, and chatty long conversations

Usage advice: use single for everyday questions and short tasks; use preserve for long tasks, multi-turn implementation, and review sessions that need stable context positions. A stable prefix helps Anthropic Prompt Caching, DeepSeek KVCache, and similar caches, potentially lowering latency and cost — actual gains depend on the provider and request content. preserve increases historical token pressure; switch back to single or enable automatic summarization if context gets too long.

The dynamic context policy is configured per prompt mode; the input area also provides a “send and preserve previous dynamic context in place” entry to override the policy for a single send.

**Context awareness settings** — Settings → Context controls which information can become dynamic context: workspace file tree, maximum tree depth, open tabs, active editor path, VS Code diagnostics with severity and count limits, and custom ignore patterns for files such as dependencies, logs, and build output.

These switches decide whether variables can produce content; whether the prompt template or entries reference those variables decides whether the content is actually included in requests.

**Template variables** — System prompts, dynamic context templates, and prompt entries support variables in the form `{{$VARIABLE}}`.

Common static variables include `{{$ENVIRONMENT}}` (workspace path, operating system, time zone, user language, and other environment information), `{{$CONTEXT_BADGE_FORMAT}}` (the format description for input context badges), `{{$TOOLS}}` (built-in tool descriptions, generated for the current channel tool mode), `{{$MCP_TOOLS}}` (tool descriptions from connected MCP servers), and `{{$MEMORY}}` (usage instructions for the permanent memory system).

Common dynamic variables include `{{$TODO_LIST}}` (current session TODO state), `{{$WORKSPACE_FILES}}` (workspace file tree), `{{$OPEN_TABS}}` (open editor tabs), `{{$ACTIVE_EDITOR}}` (active editor path), `{{$DIAGNOSTICS}}` (VS Code diagnostics), `{{$PINNED_FILES}}` (pinned file contents), and `{{$SKILLS}}` (summaries or contents of enabled Skills).

In the prompt-entry editor you can click “Insert variable” to append a variable to the current entry. If context descriptions look wrong after an upgrade, restore the default templates in prompt settings and customize them again.

**Pinned files and context badges** — The input area supports context badges for files or directories, selected code, attachments, pinned files, and Skills. These badges tell the model exactly what to focus on in the current turn.

## MCP, Skills, and Sub-Agents

**MCP** — Add servers in Settings → MCP. stdio servers require command, arguments, and environment variables; SSE servers require an SSE URL and headers; streamable HTTP servers require an HTTP URL and headers. Connected server tools are exposed to the model. Schema cleanup can be enabled for models that are strict about JSON Schema fields.

**Skills** — Skills are reusable knowledge modules for project conventions, commit rules, troubleshooting guides, framework knowledge, or domain-specific instructions. Enabled Skills appear in the available list, and the assistant loads their complete content with `read_skill` when needed.

**Sub-Agents** — Sub-Agents divide work between specialized roles such as test analysis, documentation, security review, or frontend styling. Each agent can have its own prompt and allowed tools. Memory tools are excluded from Sub-Agents to prevent duplicate or incorrect cross-session memory writes. The main model can pass `continueFromRunId` to continue a new agent run from a completed previous run.

**SubAgent Monitor** — The independent SubAgent Monitor panel shows and manages agent runs in real time:

- Multiple run tabs to monitor several agents at once
- Automatic output following that keeps scrolling as content grows
- Pause / resume / exit controls to intervene mid-run
- Read-only historical runs (completed or cancelled runs are marked as “Historical run · view only”)
- “Load earlier messages” to page through the full transcript
- Background runs flow back as compact cards in the main chat and can jump to the Monitor for the full record

## Data Storage and Sync

**VS Code Settings Sync** — Most settings are stored under the `graycode.*` VS Code settings namespace and can sync through VS Code Settings Sync, including tool switches, auto-execution policies, prompt configuration, UI preferences, token counting, and image tool configuration.

Machine-level settings are excluded from sync: `graycode.proxy`, `graycode.storagePath`, and `graycode.activeChannelId`, so proxy ports, storage paths, and the active channel never overwrite each other across machines.

**Custom storage path** — Configure and migrate the data storage path in Settings → General. Reload the window after migration.

**Legacy migration** — When upgrading from older versions, GrayCode attempts to migrate the legacy `globalStorage/settings/settings.json` into VS Code settings and backs up the old file as `settings.json.bak`.

**Settings import and export** — Settings → General can export channel configuration, MCP servers, Skills, and VS Code settings to JSON, or import them from a file. Import supports both skipping existing items and overwriting all items.

Export does not include conversation history, checkpoints, raw permanent-memory data, or workspace files; migrate the storage path or back them up separately. You can also run `GrayCode: Export Settings` and `GrayCode: Import Settings` from the Command Palette.

## Installation and Updates

VS Code `^1.84.0` or newer is required. Node.js 20 or newer is recommended for source builds and VSIX packaging. This extension is published on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode); you can also install it from a VSIX package or from source.

**Automatic updates** — The extension periodically checks GitHub Releases for new versions after startup. When a new version is available, a dialog shows the release notes; on confirmation it downloads the VSIX and installs it automatically. You can also use “Check now” or “One-click update” in Settings → General → Automatic updates.

**Install from VSIX** — Download a `graycode-*.vsix` file from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases), or build one locally. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run `Extensions: Install from VSIX...`, and select the VSIX file.

**Build and install from source** — This repository uses npm and commits `package-lock.json`:

```bash
# Clone the repository
git clone https://github.com/Komeiji-Shiki/Gray-Code.git
cd Gray-Code

# Install root dependencies
npm ci

# Install frontend dependencies
npm --prefix frontend ci

# Full build
npm run build

# Package the VSIX
npx @vscode/vsce package
```

## Local Development

**Recommended: VS Code debug configuration** — Open this repository and choose `Run Extension (Local Vite Dev)` in Run and Debug. It starts the backend esbuild watcher, starts the frontend Vite dev server on port 5173, and sets `GRAYCODE_WEBVIEW_DEV_SERVER_URL=http://127.0.0.1:5173` so the webview loads local frontend resources. The Vite dev server is only used in extension development mode; production builds use `frontend/dist`.

**Manual startup** — Run `npm run watch` in terminal A, run `npm run dev:frontend` in terminal B, then use the normal `Run Extension` configuration or a custom configuration with `GRAYCODE_WEBVIEW_DEV_SERVER_URL`.

**Common scripts** —

- `npm run compile` — bundles the extension backend with esbuild
- `npm run typecheck` — runs TypeScript checks for the backend and the extension
- `npm run watch` — starts esbuild watch mode
- `npm run build:frontend` — builds the webview frontend
- `npm run dev:frontend` — starts the local frontend dev server
- `npm run build` — builds the backend and the frontend webview
- `npm test` — runs backend Jest tests
- `npm run test:frontend` — runs frontend Vitest tests
- `npm run test:coverage` — runs backend tests with coverage

## Project Structure

```text
Gray-Code/
├── backend/                 # Extension backend capabilities
│   ├── __tests__/           # Backend Jest regression tests
│   ├── core/                # Core context, logging, and shared services
│   ├── modules/             # Channels, configuration, conversations, MCP, prompts, settings, and other modules
│   └── tools/               # Built-in tool implementations
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

**Where do I accept a diff?** When a tool creates a file modification, VS Code opens a diff preview.

Use the editor title actions or keyboard shortcuts: accept the current block (`Ctrl+Shift+Y` / `Cmd+Shift+Y` on macOS), reject the current block (`Ctrl+Shift+N` / `Cmd+Shift+N` on macOS), go to the next block (`Alt+]`), or go to the previous block (`Alt+[`). Commands are also available: `GrayCode: Accept All Changes`, `GrayCode: Reject All Changes`, `GrayCode: Accept Diff Block...`, and `GrayCode: Reject Diff Block...`.

**Why do Windows notifications or sounds not appear?** Check whether the corresponding event is enabled in Settings → Sound, whether Windows allows VS Code notifications, and whether the webview has been allowed to play audio by the browser policy.

## Contributing

Issues and pull requests are welcome through [GitHub Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues). Before submitting, run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:frontend` to make sure type checking, backend and frontend builds, and both test suites pass. If your change affects frontend interaction, also verify the local webview development mode.

## Related Projects

Community-maintained projects based on this repository:

- [**GrayCode Desktop**](https://github.com/czocelot/Gray-Code-Desktop) — A standalone desktop app (Electron) that runs without VS Code, powered by a built-in `vscode-shim` compatibility layer with the same features as the extension. Available for Windows / macOS / Linux, with both installer and portable versions ([Releases](https://github.com/czocelot/Gray-Code-Desktop/releases)). It shares the same backend / frontend / webview codebase with this repository and is continuously synced with upstream by community maintainers.

> Derived projects are maintained independently by the community; their release cadence and features may differ from this repository. Please refer to the corresponding repository for details.

## Acknowledgements

Special thanks to the following friends for their help and support:

- [**1b0t3**](https://github.com/1b0t3) — opencode GO package, GPT 5.6 sol, and the project icon/logo
- [**czocelot**](https://github.com/czocelot) — DeepSeek V4 Flash, plus bug hunting, testing, and fixes; also created [Gray-Code-Desktop](https://github.com/czocelot/Gray-Code-Desktop)
- [**NebulaRaven**](https://github.com/NebulaRaven) — bug hunting, testing, and fixes

## License

This project is licensed under the [MIT License](LICENSE).
