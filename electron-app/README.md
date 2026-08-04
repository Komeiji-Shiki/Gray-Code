# GrayCode Desktop

> **GrayCode AI 编程助手 · 独立桌面版** — 不依赖 VS Code 的完整前端
> **GrayCode AI coding assistant · standalone desktop edition** — the full extension experience without VS Code

[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)

基于 [GrayCode](https://github.com/Komeiji-Shiki/Gray-Code)（VS Code AI 编程助手插件 v1.3.1）构建的独立桌面应用。
同一套后端代码、同一套前端界面，通过 Electron 主进程中的 `vscode` API 兼容层（shim）运行在原生桌面环境 —— **无需安装 VS Code**。

Built on top of [GrayCode](https://github.com/Komeiji-Shiki/Gray-Code) (VS Code AI coding assistant extension v1.3.1).
The same backend, the same UI — running in a native desktop window via an Electron main-process `vscode` API shim. **No VS Code required.**

---

## 功能特性 / Features

- 🤖 **多模型渠道**：Gemini / OpenAI / Claude / DeepSeek 等任意 OpenAI 兼容端点，每个渠道独立配置 API Key、URL、模型
- 💬 **对话**：流式输出、多轮对话、Markdown / Mermaid / KaTeX 渲染、对话历史持久化、多标签页
- 🌳 **重 roll 树状分叉**：重新生成回答时旧版本自动保存，消息上出现 v1/v2/v3 版本切换器，随时切回历史分支（DeepSeek 网页版交互）
- 🛠 **Agent 工具**：读文件、写文件、`apply_diff` 差异应用、执行终端命令、MCP 服务器、子代理、任务队列、检查点回滚、图像生成、LSP 符号/定义/引用查询、记忆、技能
- 📡 **子代理 Monitor 内嵌面板**：主窗口右侧分区实时查看子代理运行（流式输出/工具调用/暂停/继续/退出/删除/重试/历史分页），不占用任务栏，可随时折叠
- 🔧 **变更查看面板（GitHub 风格）**：模型修改文件时右侧弹出内嵌面板（非独立窗口）——左侧文件列表（状态 + ±行数），右侧统一 diff（hunk 头 / 双行号 / 增删着色），单文件或全部接受 / 拒绝，删除警戒提示，`diff.statusChanged` 状态同步
- ⚙️ **完整设置面板**：渠道、工具、自动执行、MCP、子代理、存档点、总结、图像生成、扩展依赖、上下文、提示词、Token 计数、通知、外观、记忆、通用（16 个页签）
- 📊 **用量统计**：全部 / 今天 / 近 7 天 / 近 30 天
- 🖥 **工作区**：打开任意文件夹作为工作区，工具在真实文件系统上执行
- 🌐 **汉 / EN / 日本語 三语 UI**：顶部栏一键切换，可跟随系统语言（Auto）
- 🎨 **VS Code Dark+ 主题**：与插件版视觉一致

---

## 快速开始 / Quick Start

### 直接下载（Windows）

从 Releases 下载 `GrayCode-Setup-x.y.z.exe`（NSIS 安装包）或 `GrayCode-x.y.z-win.zip`（免安装版）。
下载后启动 → `File → Open Workspace Folder...` 打开工作区 → 右上角齿轮进入设置 → 「渠道」填入 API Key → 开始使用。

### 从源码构建

```bash
# 0. 环境要求: Node.js >= 20
cd electron-app
npm install          # 安装依赖（含 electron / electron-builder）

npm start            # 一键：构建前端 + 打补丁 + 构建主进程 + 启动应用
```

### 快速启动脚本（推荐）

无需手动构建，双击或一条命令即可启动；依赖缺失自动安装、构建产物过期自动重建，二次启动秒开：

```bash
# Windows：双击 start.bat，或在终端运行
cd electron-app
start.bat

# macOS / Linux
chmod +x start.sh
./start.sh

# 强制全量重建后启动
start.bat --rebuild      # Windows
./start.sh --rebuild     # macOS / Linux
```

> 注意：首次运行需网络下载 Electron 二进制。

---

## 开发 / Development

```bash
npm run build:all    # 前端 vite build + patch-dist + esbuild 主进程
npm run build        # 仅 esbuild 主进程（dist/main.js, dist/preload.js）
npm run dev          # 直接启动（使用已有构建产物）
```

环境变量：

| 变量 | 作用 |
|---|---|
| `GRAYCODE_REPO_ROOT` | 覆盖资源根目录（默认按构建布局自动推导） |
| `GRAYCODE_E2E=1` | 运行后端 E2E 测试后自动退出 |
| `GRAYCODE_UISMOKE=1` | 运行 UI 冒烟测试（页面遍历 + 性能采集）后自动退出 |
| `GRAYCODE_MONITOR_SMOKE=1` | 运行子代理 Monitor 内嵌面板协议冒烟测试后自动退出 |
| `GRAYCODE_DIAG=1` | 输出渲染进程 DOM 诊断后退出 |
| `GRAYCODE_SHOT=<png>` | 加载完成后截图并退出 |

## 测试 / Testing

```bash
npm run e2e      # 后端 E2E：渠道/对话/流式工具/差异应用/确认流/MCP/子代理/CJK 工作区（40+ 断言）
npm run smoke    # UI 冒烟：页面跳转、设置 16 页签、语言切换、Monitor 面板、渲染错误 & long task 采集
# 子代理 Monitor 面板协议冒烟：
#   $env:GRAYCODE_MONITOR_SMOKE='1'; .\node_modules\.bin\electron.cmd .
```

## 打包发布 / Packaging

```bash
npm run dist:win      # Windows: NSIS 安装包 + zip
npm run dist:mac      # macOS:   dmg + zip（需 macOS 环境）
npm run dist:linux    # Linux:   AppImage + deb
```

产物输出到 `electron-app/release/`。

---

## 架构 / Architecture

```
┌─────────────────────────── Electron ───────────────────────────┐
│  Main process                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ BackendHost (backend/ + webview/ 全量复用，零改动)        │   │
│  │   └── import 'vscode' ── esbuild alias ──► vscode-shim.ts │   │
│  │        (Uri / workspace.fs / 配置 / 对话框 / diff 命令…)   │   │
│  │ ElectronContext = 伪 ExtensionContext（userData 持久化）   │   │
│  └──────────────┬──────────────────────────────────────────┘   │
│                 │ graycode:// 自定义协议（静态资源，无 CORS）    │
│  Renderer (Vue3 + Pinia) ◄─preload 桥─► vscode-shim            │
└───────────────────────────────────────────────────────────────┘
```

关键设计 / Key design decisions：

| 决策 | 说明 |
|---|---|
| 后端进主进程 + shim | esbuild 把 `vscode` 别名为 `src/vscode-shim.ts`，后端代码完全未改 |
| 前端零改动复用 | preload 提供 `acquireVsCodeApi()` 桥；消息协议与 VS Code 版完全一致 |
| `graycode://` 协议 | 用 `protocol.handle` + MIME 表服务资源，规避 `file://` 的 fetch/audio CORS 限制 |
| Diff 预览 | `vscode.diff` 命令被 shim 拦截 → `host.openDiffPreview` 命令 → 主窗口内嵌变更查看面板（GitHub 风格，非独立窗口）→ `diff.accept/reject` |
| 对话框 | `showQuickPick` / `showInputBox` / toast → 渲染层 Overlay（原生 JS，与 Vue 解耦） |
| 子代理 Monitor | `SubAgentMonitorBridge` 订阅 run 事件总线 → 主窗口右侧内嵌面板（无独立窗口），折叠时自动停推高频事件 |
| 持久化 | 设置/配置/历史/MCP 等全部落在 `userData`，可配置自定义存储路径 |

## 目录结构 / Project layout

```
electron-app/
├── src/
│   ├── main.ts            # 窗口/菜单/协议/原生操作 IPC/调试模式
│   ├── preload.ts         # acquireVsCodeApi 桥 + 消息双向转发
│   ├── vscode-shim.ts     # ⭐ vscode API 兼容层（Uri/workspace/window/commands…）
│   ├── builtinLsp.ts      # 轻量符号/定义/引用提取（替代 execute*Provider）
│   ├── native.ts          # dialog / shell / clipboard 原生操作
│   ├── e2e.ts             # 端到端测试（7 场景）
│   ├── monitor-smoke.ts   # 子代理 Monitor 内嵌面板协议冒烟
│   └── host/
│       ├── ElectronContext.ts   # 伪 ExtensionContext
│       ├── BackendHost.ts       # 后端初始化 + MessageRouter + 渲染层桥
│       └── SubAgentMonitorBridge.ts  # 子代理事件订阅 → 内嵌面板推送
├── renderer/
│   ├── theme.css          # VS Code Dark+ 主题变量
│   └── overlay.js         # toast / quickPick / inputBox（Diff 已移至前端内嵌面板）
├── test/mock-mcp-server.cjs    # E2E 用 MCP stdio mock 服务器
├── build.mjs              # esbuild 打包（vscode→shim 别名）
├── patch-dist.mjs         # 前端产物注入 codicons/theme/overlay/sound
├── start.bat / start.sh   # 快速启动脚本（按需安装依赖 + 增量构建）
└── dist/                  # 构建产物（main.js / preload.js）
```

依赖的上游目录（本仓库根目录）：`frontend/`（Vue3 UI）、`backend/`（后端模块）、`webview/`（消息路由与 Handler）、`resources/`（图标/音效）。

## 数据存储 / Data storage

Windows: `%APPDATA%\GrayCode Desktop\graycode\`
macOS: `~/Library/Application Support/GrayCode Desktop/graycode/`
Linux: `~/.config/GrayCode Desktop/graycode/`

包含设置、渠道配置（含 API Key）、对话历史、MCP 配置、记忆、检查点等。
可在 设置 → 通用 中自定义存储路径。

---

## 致谢 / Credits

- 原项目：[Komeiji-Shiki/Gray-Code](https://github.com/Komeiji-Shiki/Gray-Code) — VS Code AI 编程助手插件
- 前端框架：[Vue 3](https://vuejs.org/) · [Pinia](https://pinia.vuejs.org/) · [Vite](https://vitejs.dev/)
- 桌面框架：[Electron](https://www.electronjs.org/) · [electron-builder](https://www.electron.build/)
- 图标字体：[VS Code Codicons](https://github.com/microsoft/vscode-codicons)

## License

MIT — 与原项目一致。详见根目录 [LICENSE](../LICENSE)。
