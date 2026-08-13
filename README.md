# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>一个面向 VS Code 的 AI 编程助手</strong>
</p>

<p align="center">
  多模型渠道 · 代码工具 · MCP · Skills · Sub-Agents · 永久记忆
</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode"><img src="https://img.shields.io/visual-studio-marketplace/v/Komeiji-Shiki.graycode?style=flat-square&logo=visualstudiocode&label=Marketplace" alt="VS Code Marketplace" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Komeiji-Shiki/Gray-Code/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Komeiji-Shiki/Gray-Code?style=flat-square" alt="MIT License" /></a>
</p>

GrayCode 把 AI 编程能力带进 VS Code：理解工作区、搜索和修改代码、执行命令、调用语言服务，并通过原生 Diff 让你在落盘前检查改动。它既适合快速问答与 Bug 定位，也支持从设计、计划、实现到审查的完整工程流程。

所有核心数据保存在本地；你可以接入不同模型渠道，通过 MCP、Skills 和 Sub-Agents 扩展能力，并让永久记忆跨会话保存项目约定与关键决策。

## 快速开始

1. 在 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode) 搜索 **Gray Code** 并安装；也可以从 [Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 下载 VSIX。
2. 点击活动栏中的 Gray Code 图标，进入右上角 **设置 → 渠道**，添加 Gemini、OpenAI Compatible、OpenAI Responses 或 Anthropic 渠道。
3. 回到聊天页，选择渠道、模型和 Code / Design / Plan / Ask / Review 模式，然后直接描述任务。

第一次可以试试：

> 请阅读这个项目的结构，解释主要模块，并给出上手建议。

或者：

> 请定位这个异常的原因。先搜索相关代码并说明证据，确认方案后再修改和测试。

[查看完整快速开始指南 →](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started-zh-CN)

## 核心亮点

- **多模型渠道** —— 支持 Gemini、OpenAI Chat Completions 兼容接口、OpenAI Responses 与 Anthropic，每个渠道可独立配置模型、工具模式、思考、重试和 Token 计数。
- **真实代码操作** —— 读取、搜索和修改文件，运行终端命令，调用 VS Code LSP，支持图片、PDF 等多模态上下文；写入可通过 Diff 审阅。
- **结构化工作流** —— 内置 Design、Plan、Progress、Review 与 TODO 工具，让复杂任务从方案到验证都有可追踪记录。
- **可扩展代理能力** —— 连接 MCP Server，加载可复用 Skills，并通过前台或后台 Sub-Agents 并行处理专门任务。
- **本地永久记忆** —— 全局与工作区记忆彼此隔离，跨会话保存约定、知识和决策，不依赖外部记忆服务。
- **长任务与长对话** —— 支持消息队列、自动总结、存档点、树状分支对话、后台结果回流，以及 Token、成本和使用时间统计。

[查看完整功能说明 →](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features-zh-CN)

## 常用工作流

| 目标 | 推荐方式 |
| --- | --- |
| 理解陌生项目或定位 Bug | 使用 Ask / Code 模式，让 AI 先搜索、读取并给出证据 |
| 实现复杂需求 | Design 明确方案 → Plan 拆分步骤 → Code 实现与测试 |
| 检查已有改动 | Review 模式结合 Git Diff，生成结构化审查结论 |
| 扩展专用能力 | 配置 MCP、编写 Skill，或派发专用 Sub-Agent |

## 文档

完整用户手册已迁移到 [GrayCode Wiki](https://github.com/Komeiji-Shiki/Gray-Code/wiki)：

| 指南 | 内容 |
| --- | --- |
| [快速开始](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started-zh-CN) | 安装、渠道配置、模式选择、Diff 确认与更新 |
| [功能概览](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features-zh-CN) | 核心能力、对话体验、分支、存档点与统计 |
| [模型与渠道](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Models-and-Channels-zh-CN) | 四类渠道、工具模式、思考与 Token 计数 |
| [工具与工作流](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Tools-and-Workflows-zh-CN) | 内置工具、自动执行、Diff 和工程工作流 |
| [上下文与提示词](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Context-and-Prompts-zh-CN) | Prompt 模式、模板、动态上下文与变量 |
| [MCP、Skills、Sub-Agents 与记忆](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Extensions-and-Memory-zh-CN) | 扩展能力与本地永久记忆 |
| [设置、存储与同步](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Settings-Storage-and-Sync-zh-CN) | 设置索引、备份、迁移、导入导出与同步 |
| [常见问题](https://github.com/Komeiji-Shiki/Gray-Code/wiki/FAQ-zh-CN) | 工具、上下文、Diff、通知等问题排查 |

开发环境、项目结构和提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 安装与更新

GrayCode 要求 VS Code `^1.84.0` 或更高版本。推荐从 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode) 安装；也可以从 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 下载 `graycode-*.vsix`，在命令面板执行 `Extensions: Install from VSIX...`。

扩展支持自动检查 GitHub Releases，并可在 **设置 → 通用 → 自动更新** 中手动检查或一键更新。源码构建和 VSIX 打包步骤见 [贡献指南](CONTRIBUTING.md)。

## 社区

- 通过 [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) 报告问题或提出建议。
- 欢迎提交 Pull Request；开始前请阅读 [贡献指南](CONTRIBUTING.md)。
- 社区维护的 [GrayCode Desktop](https://github.com/czocelot/Gray-Code-Desktop) 提供独立 Electron 桌面版，支持 Windows、macOS 和 Linux；其发布节奏以对应仓库为准。

## 鸣谢

感谢 [1b0t3](https://github.com/1b0t3)、[czocelot](https://github.com/czocelot) 和 [NebulaRaven](https://github.com/NebulaRaven) 对模型资源、图标、测试、问题排查、修复与项目协作的帮助。

## 许可证

本项目采用 [MIT License](LICENSE)。
