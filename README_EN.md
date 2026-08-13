# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>An AI coding assistant for VS Code</strong>
</p>

<p align="center">
  Multiple model providers · Coding tools · MCP · Skills · Sub-Agents · Persistent memory
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README_EN.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode"><img src="https://img.shields.io/visual-studio-marketplace/v/Komeiji-Shiki.graycode?style=flat-square&logo=visualstudiocode&label=Marketplace" alt="VS Code Marketplace" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Komeiji-Shiki/Gray-Code/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Komeiji-Shiki/Gray-Code?style=flat-square" alt="MIT License" /></a>
</p>

GrayCode brings agentic coding into VS Code. It understands your workspace, searches and edits code, runs commands, queries language services, and presents file changes in native diffs before they are accepted. It works equally well for quick questions, bug investigation, and structured design-to-review workflows.

Core data stays local. You can choose among multiple model providers, extend the assistant with MCP, Skills, and Sub-Agents, and retain project conventions and decisions across conversations with persistent memory.

## Quick Start

1. Install **Gray Code** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode), or download a VSIX from [Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases).
2. Open Gray Code from the Activity Bar, then go to **Settings → Channels** and add a Gemini, OpenAI Compatible, OpenAI Responses, or Anthropic channel.
3. Return to chat, select a channel, model, and Code / Design / Plan / Ask / Review mode, then describe the task.

Try one of these prompts:

> Read this project's structure, explain the main modules, and suggest where to start.

> Investigate this bug. Search the relevant code and explain the evidence before changing and testing it.

[Read the full getting-started guide →](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started)

## Highlights

- **Multiple model providers** — Gemini, OpenAI Chat Completions-compatible APIs, OpenAI Responses, and Anthropic, each with independent model, tool, reasoning, retry, and token-counting settings.
- **Real coding operations** — Read, search, and edit files; run terminal commands; query VS Code language services; attach multimodal context; and review writes through native diffs.
- **Structured workflows** — Design, Plan, Progress, Review, and TODO tools keep complex work traceable from proposal through validation.
- **Extensible agents** — Connect MCP servers, load reusable Skills, and delegate specialized work to foreground or background Sub-Agents.
- **Local persistent memory** — Separate global and workspace memories retain conventions, knowledge, and decisions without an external memory service.
- **Long-running work** — Message queues, automatic summarization, checkpoints, branching conversations, background result delivery, and usage statistics support extended tasks.

[Explore all features →](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features)

## Common Workflows

| Goal | Recommended approach |
| --- | --- |
| Understand a codebase or investigate a bug | Use Ask / Code mode and have the assistant search, read, and cite evidence first |
| Implement a complex feature | Design the solution → create a Plan → implement and test in Code mode |
| Review existing changes | Use Review mode with the Git diff and produce a structured review |
| Add specialized capabilities | Configure MCP, write a Skill, or delegate to a dedicated Sub-Agent |

## Documentation

The complete user guide lives in the [GrayCode Wiki](https://github.com/Komeiji-Shiki/Gray-Code/wiki):

| Guide | Covers |
| --- | --- |
| [Getting Started](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started) | Installation, channel setup, modes, diff confirmation, and updates |
| [Feature Overview](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features) | Core capabilities, conversation UX, branches, checkpoints, and statistics |
| [Models and Channels](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Models-and-Channels) | Provider types, tool modes, reasoning, and token counting |
| [Tools and Workflows](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Tools-and-Workflows) | Built-in tools, auto-execution, diffs, and engineering workflows |
| [Context and Prompts](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Context-and-Prompts) | Prompt modes, templates, dynamic context, and variables |
| [MCP, Skills, Sub-Agents, and Memory](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Extensions-and-Memory) | Extensibility and local persistent memory |
| [Settings, Storage, and Sync](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Settings-Storage-and-Sync) | Settings index, backups, migration, import/export, and sync |
| [FAQ](https://github.com/Komeiji-Shiki/Gray-Code/wiki/FAQ) | Troubleshooting tools, context, diffs, notifications, and more |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, repository structure, and contribution guidelines. See [CHANGELOG.md](CHANGELOG.md) for release history.

## Installation and Updates

GrayCode requires VS Code `^1.84.0` or newer. Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode), or download `graycode-*.vsix` from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) and run `Extensions: Install from VSIX...` from the Command Palette.

The extension can check GitHub Releases automatically. You can also check or update manually under **Settings → General → Automatic Updates**. Source builds and VSIX packaging are documented in the [contribution guide](CONTRIBUTING.md).

## Community

- Use [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) for bug reports and proposals.
- Pull Requests are welcome; read the [contribution guide](CONTRIBUTING.md) before starting.
- The community-maintained [GrayCode Desktop](https://github.com/czocelot/Gray-Code-Desktop) provides an Electron desktop edition for Windows, macOS, and Linux. Its release schedule is independent of this repository.

## Acknowledgements

Thanks to [1b0t3](https://github.com/1b0t3), [czocelot](https://github.com/czocelot), and [NebulaRaven](https://github.com/NebulaRaven) for model access, artwork, testing, issue investigation, fixes, and project collaboration.

## License

GrayCode is available under the [MIT License](LICENSE).
