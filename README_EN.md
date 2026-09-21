# GrayCode

**A local-first AI workspace for conversations, coding, visual tools, and agent tasks.**

[简体中文](README.md) · [User guide](wiki/Home.md) · [Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) · [Contributing](CONTRIBUTING.md)

GrayCode combines model conversations, files, an editor, terminals, Git review, and tool execution in a standalone desktop app. Connect your own model endpoints, operate a computer or the built-in browser from screenshots, and extend tasks through MCP, Skills, subagents, or external ACP coding agents. Conversations, attachments, task records, and memory are stored locally.

![GrayCode workbench with a synthetic project and conversation](wiki/assets/workbench.png)

The source version is **2.0.0-pre.2**. Windows x64 is the build and validation target for this work. Release assets correspond to their published commits; unreleased changes require a source build. The 1.x VS Code extension is retained on [v1-extension](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension).

## Get started

1. Download a Windows package from [Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases). Extract the complete portable archive and run GrayCode.exe, or use the matching installer.
2. Open Settings and add a channel with your endpoint, credential, and model. Supported formats include OpenAI Chat Completions, OpenAI Responses, Anthropic, and Gemini.
3. Select a workspace and describe a task. Keep the conversation beside files, an editor, a terminal, a diff, or the browser. A project is optional for general conversations.

Settings sections share a draft committed by Save All. Switching modes keeps the current conversation; creating a new task is a separate action. See [Getting started](wiki/Getting-Started.md).

## Features

| Area | Capabilities |
| --- | --- |
| Conversations | Multiple model channels, reasoning settings, streaming, editing, rerolling, branches, attachments, and long context |
| Coding | File search, editor and language services, interactive terminals, Git diffs, and tasks created in selected worktrees |
| Visual tools | Screenshot observation, image-coordinate clicking/dragging/typing, and browser operation with background rendering |
| Extensions | Skills, legacy and current MCP protocols, native subagents and teams, and external ACP sessions |
| Automation | Goal, schedule, and event tasks; pause/resume; background task feedback |
| Multiple clients | Web workspace, Discord, OneBot, paired execution nodes, and remote computer views |
| Local data | Durable history and memory, backup/restore, model request snapshots, image counts, and resource diagnostics |

### Screenshots and context

With multimodal input enabled on a capable channel, tool screenshots become image content in model requests. Computer tools primarily return an image and concise observation metadata; accessibility trees are available on demand. Browser tools support both image coordinates and existing DOM operations. Actions return a fresh observation when capture succeeds.

![Synthetic browser page used for screenshot and coordinate validation](wiki/assets/browser.png)

Coordinates belong to a particular observation. Changes to window geometry, zoom, or control ownership require another observation. Action completion and a subsequent capture failure are recorded separately. Retrying an existing operation uses its receipt to avoid repeating an action.

**Adding images does not automatically discard earlier images.** The recent-N-images setting has been removed. Reference images and tool screenshots remain in history order. Stable instructions, tool declarations, and history prefixes support provider prompt caching; actual cache hits and pricing depend on the endpoint. Explicit context compaction remains a separate operation. See [Models and context](wiki/Models-and-Context.md).

### External coding agents

Configure an installed ACP program under Settings → Development. For Kimi Code, use kimi with the argument acp; other ACP adapters can be configured through the same command, argument, and environment fields. The external program manages its own login and models.

The stable coding_agent tool creates, prompts, restores, forks, configures, and closes sessions. Only new input is appended. Permission choices retain their original option IDs and meanings. Interrupted requests with unknown results are recorded and are not automatically replayed. See [Agents and MCP](wiki/Agents-and-MCP.md).

## Performance changes

These are same-machine synthetic component measurements, not whole-application guarantees.

| Workload | Before | After |
| --- | ---: | ---: |
| Mount/layout of an 8,000-entry file tree | 787.5 ms median; 40,011 DOM elements | 21.8 ms; 204 DOM elements |
| Unchanged active history with 8,000 messages | About 99 ms; about 5.36 MB | About 0.22 ms; 385 B incremental response |
| Hybrid search over 8,000 × 768-dimensional vectors | 108.84 ms median | 66.17 ms |
| Compressed objects for 100 growing model requests | 12.55 MB | 1.09 MB |

The tree renders visible rows; history uses incremental reads; vector calculation runs off the storage thread. Text deltas are batched and independently eligible reads run with bounded concurrency. Request snapshots share identical messages and tool objects while reconstructing the complete original request. Full snapshot reads become somewhat slower. See [Performance and validation](wiki/Performance-and-Validation.md).

## Build

Use Node.js **22.15 or newer**. The Windows computer host uses the system .NET Framework 4 compiler; a separate .NET SDK is normally unnecessary.

~~~powershell
npm ci
npm --prefix frontend ci
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
~~~

~~~powershell
npm run ci
npm run package:desktop
~~~

The formal desktop package runs the full desktop build. Its default output is release/desktop/GrayCode-win32-x64; set GRAYCODE_DESKTOP_OUT for a separate output directory. build:desktop:trial is a faster compilation path. See [Contributing](CONTRIBUTING.md) and the [architecture map](PROJECT_STRUCTURE.md).

## Documentation and license

The repository [Wiki](wiki/Home.md) covers setup, model context, visual tools, worktrees, agents, automation, devices, data, and diagnostics. [CHANGELOG](CHANGELOG.md) describes source changes. GrayCode's own code is [MIT licensed](LICENSE); bundled components retain their respective [upstream licenses](resources/licenses/README.md).
