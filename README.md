# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>本地优先的 AI 工作台与编程助手</strong>
</p>

<p align="center">
  多模型渠道 · 代码工具 · MCP · Skills · Sub-Agents · 永久记忆
</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><img src="https://img.shields.io/github/v/release/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github&label=Releases" alt="Latest Release" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode"><img src="https://img.shields.io/visual-studio-marketplace/v/Komeiji-Shiki.graycode?style=flat-square&logo=visualstudiocode&label=Marketplace" alt="VS Code Marketplace" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Komeiji-Shiki/Gray-Code/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Komeiji-Shiki/Gray-Code?style=flat-square" alt="MIT License" /></a>
</p>

GrayCode 2.0 提供独立桌面工作台：理解工作区、搜索和修改代码、执行命令、调用语言服务，并通过 Diff 审阅文件改动。它支持多模型对话、角色聊天、机器人入口和带共享任务的子代理协作。

Windows x64 桌面版可从 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 获取，支持便携版与安装版。`main` 维护独立桌面版，1.x VS Code 扩展源码保留在 [`v1-extension`](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension) 分支，旧扩展仍可通过原渠道获取。

所有核心数据保存在本地；你可以接入不同模型渠道，通过 MCP、Skills 和 Sub-Agents 扩展能力，并让永久记忆跨会话保存项目约定与关键决策。

## 快速开始

1. 从 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 下载 Windows 桌面版，使用安装器安装，或完整解压便携包后运行 `GrayCode.exe`。
2. 进入 **设置 → 渠道**，添加自己的 Gemini、OpenAI Compatible、OpenAI Responses 或 Anthropic 渠道。
3. 回到聊天页，选择渠道、模型和 Code / Design / Plan / Ask / Review 模式，然后直接描述任务。

第一次可以试试：

> 请阅读这个项目的结构，解释主要模块，并给出上手建议。

或者：

> 请定位这个异常的原因。先搜索相关代码并说明证据，确认方案后再修改和测试。

[使用手册](https://github.com/Komeiji-Shiki/Gray-Code/wiki) · [独立桌面运行与构建说明](apps/desktop/README.md) · [Web 入口](apps/server/WEB.md)

## 核心亮点

- **多模型渠道** —— 支持 Gemini、OpenAI Chat Completions 兼容接口、OpenAI Responses 与 Anthropic，每个渠道可独立配置模型、工具模式、思考、重试和 Token 计数。
- **真实代码操作** —— 读取、搜索和修改文件，运行终端命令，调用语言服务，支持图片、PDF 等多模态上下文；写入可通过 Diff 审阅。
- **结构化工作流** —— 内置 Design、Plan、Progress、Review 与 TODO 工具，让复杂任务从方案到验证都有可追踪记录。
- **可扩展代理能力** —— 连接 MCP Server，加载可复用 Skills，通过前台或后台 Sub-Agents 协作，也可接入 Kimi Code 等支持 ACP 的外部编码代理。
- **电脑与浏览器操作** —— 在内置浏览器中浏览和操作网页，也可以让模型操作 Windows 应用，完成需要图形界面的任务。
- **本地永久记忆** —— 全局与工作区记忆彼此隔离，跨会话保存约定、知识和决策，不依赖外部记忆服务。
- **长任务与长对话** —— 支持消息队列、自动总结、存档点、后台结果回流，以及 Token、成本和使用时间统计。
- **树状分支对话** —— 重试与编辑不再覆盖旧回答：每个候选分支都可切换、独立继续发展，切换时可选联动工作区存档，让不同方案并行探索而不丢任何思路。

[查看完整使用手册 →](https://github.com/Komeiji-Shiki/Gray-Code/wiki)

## DeepSeek 视觉模型支持

GrayCode 针对 DeepSeek 视觉模型（如官方 Vision 模型）的接口限制提供专用图像预处理，可在渠道设置的「DeepSeek Vision 预处理」开关中启用（OpenAI Chat Completions、OpenAI Responses 与 Anthropic 渠道均可用）：

- **PDF 逐页栅格化** —— 将 PDF 每页渲染为图片后发送，规避纯文本抽取的局限；渲染使用可选的 `pdfjs-dist` 与 `@napi-rs/canvas`。
- **GIF 动画拆帧** —— DeepSeek 只取 GIF 第一帧，GrayCode 按时间轴采样（每秒最多 5 帧）拆成逐帧 PNG 后发送。
- **官方格式规范化** —— `read_file` 支持 PNG/JPEG/JFIF/GIF/WebP/BMP/SVG/ICO/TIFF/HEIC/HEIF/AVIF 等图片格式，发送前统一转为 DeepSeek 官方支持格式（使用可选的 `sharp`）。
- **图片尺寸优化** —— 对超大图片等比例缩放至官方推荐像素预算内，避免图片被压缩失真或被服务端拒收。
- **请求前校验** —— 发送前校验长边、图片数量、单图体积与请求体总大小等上限。

相关依赖（`sharp` / `pdfjs-dist` / `@napi-rs/canvas`）可在「依赖管理」面板的 DeepSeek Vision 分组中一键安装或卸载。

## 常用工作流

| 目标 | 推荐方式 |
| --- | --- |
| 理解陌生项目或定位 Bug | 使用 Ask / Code 模式，让 AI 先搜索、读取并给出证据 |
| 实现复杂需求 | Design 明确方案 → Plan 拆分步骤 → Code 实现与测试 |
| 检查已有改动 | Review 模式结合 Git Diff，生成结构化审查结论 |
| 扩展专用能力 | 配置 MCP、编写 Skill，或派发专用 Sub-Agent |

## 文档

[GrayCode 使用手册](https://github.com/Komeiji-Shiki/Gray-Code/wiki)介绍桌面版的配置与日常使用：

| 指南 | 内容 |
| --- | --- |
| [快速开始](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Getting-Started-zh-CN) | Windows 安装、便携版、渠道与首次对话 |
| [功能概览](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Features-zh-CN) | 桌面工作台、对话、项目与自动任务 |
| [模型与渠道](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Models-and-Channels-zh-CN) | 模型接口、密钥、工具和 Token 设置 |
| [工具与工作流](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Tools-and-Workflows-zh-CN) | 文件、终端、Git、电脑与浏览器操作 |
| [上下文与提示词](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Context-and-Prompts-zh-CN) | 提示词模式、动态上下文和历史 |
| [扩展与记忆](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Extensions-and-Memory-zh-CN) | MCP、Skills、代理与长期记忆 |
| [数据与诊断](https://github.com/Komeiji-Shiki/Gray-Code/wiki/Settings-Storage-and-Sync-zh-CN) | 便携配置、备份、迁移与恢复 |

开发环境与贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目结构见 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 1.x 扩展安装与更新

GrayCode 要求 VS Code `^1.84.0` 或更高版本。推荐从 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode) 安装；也可以从 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 下载 `graycode-*.vsix`，在命令面板执行 `Extensions: Install from VSIX...`。

扩展支持自动检查 GitHub Releases，并可在 **设置 → 通用 → 自动更新** 中手动检查或一键更新。扩展源码与构建说明见 [`v1-extension`](https://github.com/Komeiji-Shiki/Gray-Code/tree/v1-extension) 分支。

## 社区

- 通过 [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) 报告问题或提出建议。
- 欢迎提交 Pull Request；开始前请阅读 [贡献指南](CONTRIBUTING.md)。

## 鸣谢

感谢 [1b0t3](https://github.com/1b0t3)、[czocelot](https://github.com/czocelot) 和 [NebulaRaven](https://github.com/NebulaRaven) 对模型资源、图标、测试、问题排查、修复与项目协作的帮助。

## 许可证

本项目采用 [MIT License](LICENSE)。
