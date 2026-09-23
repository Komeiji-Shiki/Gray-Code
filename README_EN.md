# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>A local AI workspace and coding assistant</strong>
</p>

<p align="center">
  Multiple model providers · Coding tools · MCP · Skills · Sub-Agents · Persistent memory
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README_EN.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><img src="https://img.shields.io/github/v/release/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github&label=Releases" alt="Latest Release" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode"><img src="https://img.shields.io/visual-studio-marketplace/v/Komeiji-Shiki.graycode?style=flat-square&logo=visualstudiocode&label=Marketplace" alt="VS Code Marketplace" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Komeiji-Shiki/Gray-Code/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue?style=flat-square" alt="AGPL-3.0-only with Cubism exception" /></a>
</p>

GrayCode 2.0 provides a standalone desktop workspace for model conversations, coding, character chat, bot integrations, and subagents with shared tasks. It searches and edits files, runs commands, queries language services, and presents file changes for review.

The Windows x64 desktop edition is available from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases), with portable and installer packages. `main` maintains the standalone desktop edition. The 1.x VS Code extension source is preserved on [`v1-extension`](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension), and the extension remains available through its existing channels.

Core data stays local. You can choose among multiple model providers, extend the assistant with MCP, Skills, and Sub-Agents, and retain project conventions and decisions across conversations with persistent memory.

## Quick Start

1. Download the Windows desktop edition from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases). Run the installer, or extract the full portable archive and open `GrayCode.exe`.
2. Go to **Settings → Channels** and configure your own Gemini, OpenAI Compatible, OpenAI Responses, or Anthropic channel.
3. Return to chat, select a channel, model, and Code / Design / Plan / Ask / Review mode, then describe the task.

Try one of these prompts:

> Read this project's structure, explain the main modules, and suggest where to start.

> Investigate this bug. Search the relevant code and explain the evidence before changing and testing it.

[User guide](https://github.com/Komeiji-Shiki/Gray-Code/wiki) · [Desktop setup and builds](apps/desktop/README.md) · [Web access](apps/server/WEB.md)

## Highlights

- **Multiple model providers** — Gemini, OpenAI Chat Completions-compatible APIs, OpenAI Responses, and Anthropic, each with independent model, tool, reasoning, retry, and token-counting settings.
- **Real coding operations** — Read, search, and edit files; run terminal commands; query language services; attach multimodal context; and review writes through native diffs.
- **Structured workflows** — Design, Plan, Progress, Review, and TODO tools keep complex work traceable from proposal through validation.
- **Extensible agents** — Connect MCP servers, load reusable Skills, collaborate with foreground or background Sub-Agents, and use external ACP coding agents such as Kimi Code.
- **Computer and browser tools** — Browse and interact with pages in the built-in browser, or let the model operate Windows applications for tasks that need a graphical interface.
- **Local persistent memory** — Separate global and workspace memories retain conventions, knowledge, and decisions without an external memory service.
- **Long-running work** — Message queues, automatic summarization, checkpoints, background result delivery, and usage statistics support extended tasks.
- **Tree-branching conversations** — Retry and edit never overwrite old replies: every candidate branch can be switched to and grow independently, optionally restoring matching workspace checkpoints when switching, so alternative approaches can be explored without losing anything.

[Explore the user guide →](https://github.com/Komeiji-Shiki/Gray-Code/wiki)

## DeepSeek Vision Support

GrayCode provides dedicated image preprocessing for DeepSeek vision models to work around their API limitations. Enable it with the **DeepSeek Vision preprocessing** switch in channel settings (available for OpenAI Chat Completions, OpenAI Responses, and Anthropic channels):

- **PDF page rasterization** — Render every PDF page to an image before sending, avoiding the limitations of plain-text extraction; rendering uses optional `pdfjs-dist` and `@napi-rs/canvas`.
- **GIF frame extraction** — DeepSeek only reads the first GIF frame; GrayCode samples the timeline (up to 5 frames per second) and sends the frames as individual PNGs.
- **Official format normalization** — `read_file` supports PNG/JPEG/JFIF/GIF/WebP/BMP/SVG/ICO/TIFF/HEIC/HEIF/AVIF; images are converted to DeepSeek's official format before sending (using optional `sharp`).
- **Image resizing optimization** — Scale oversized images proportionally to stay within the recommended pixel budget, preventing rejection or severe distortion.
- **Pre-send validation** — Validates dimensions, image counts, per-image file sizes, and total request body limits before sending.

The related dependencies (`sharp` / `pdfjs-dist` / `@napi-rs/canvas`) can be installed or removed in one click from the DeepSeek Vision group of the dependency manager.

## Common Workflows

| Goal | Recommended approach |
| --- | --- |
| Understand a codebase or investigate a bug | Use Ask / Code mode and have the assistant search, read, and cite evidence first |
| Implement a complex feature | Design the solution → create a Plan → implement and test in Code mode |
| Review existing changes | Use Review mode with the Git diff and produce a structured review |
| Add specialized capabilities | Configure MCP, write a Skill, or delegate to a dedicated Sub-Agent |

## Documentation

The [user guide](https://github.com/Komeiji-Shiki/Gray-Code/wiki) covers setup and everyday use of the desktop edition in Chinese and English.

| Guide | Covers |
| --- | --- |
| [Getting Started](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started) | Windows installation, portable edition, channels, and first conversation |
| [Features](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features) | Desktop workbench, conversations, projects, and automation |
| [Models and Channels](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Models-and-Channels) | API providers, credentials, tools, and token settings |
| [Tools and Workflows](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Tools-and-Workflows) | Files, terminal, Git, computer, and browser operations |
| [Context and Prompts](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Context-and-Prompts) | Prompt modes, dynamic context, and history |
| [Extensions and Memory](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Extensions-and-Memory) | MCP, Skills, agents, and long-term memory |
| [Settings and Storage](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Settings-Storage-and-Sync) | Portable settings, backups, migration, and restore |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for architecture, and [CHANGELOG.md](CHANGELOG.md) for release history.

## 1.x Extension Installation and Updates

GrayCode requires VS Code `^1.84.0` or newer. Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode), or download `graycode-*.vsix` from [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) and run `Extensions: Install from VSIX...` from the Command Palette.

The extension can check GitHub Releases automatically. You can also check or update manually under **Settings → General → Automatic Updates**. Extension source and build instructions are available on the [v1-extension branch](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension).

## Community

- Use [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) for bug reports and proposals.
- Pull Requests are welcome; read the [contribution guide](CONTRIBUTING.md) before starting.

## Acknowledgements

Thanks to [1b0t3](https://github.com/1b0t3), [czocelot](https://github.com/czocelot), and [NebulaRaven](https://github.com/NebulaRaven) for model access, artwork, testing, issue investigation, fixes, and project collaboration.

## License

GrayCode uses **AGPL-3.0-only with a limited Cubism combination exception**. See [LICENSING.md](LICENSING.md) for the migration boundary, preserved historical MIT permissions, third-party notices and Corresponding Source. Commercial use is permitted subject to the applicable license requirements.
