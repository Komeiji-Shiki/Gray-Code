# Contributing to GrayCode

[简体中文](#简体中文) · [English](#english)

## 简体中文

感谢你愿意参与 GrayCode。你可以通过 [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) 报告问题、提出建议，也可以直接提交 Pull Request。

### 开发环境

- VS Code `^1.84.0`
- Node.js 20 或更高版本
- npm（仓库提交并维护 `package-lock.json`）

```bash
git clone https://github.com/Komeiji-Shiki/Gray-Code.git
cd Gray-Code
npm ci
npm --prefix frontend ci
```

### 本地开发

推荐在 VS Code 的 Run and Debug 中选择 `Run Extension (Local Vite Dev)`。该配置会启动后端 esbuild watch 和前端 Vite Dev Server，并让开发模式下的 Webview 加载 `http://127.0.0.1:5173`；生产构建仍使用 `frontend/dist`。

也可以手动启动：

```bash
# 终端 A：后端 watch
npm run watch

# 终端 B：前端开发服务器
npm run dev:frontend
```

随后使用 `Run Extension` 启动扩展宿主；如需加载本地前端，请设置：

```text
GRAYCODE_WEBVIEW_DEV_SERVER_URL=http://127.0.0.1:5173
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run compile` | 打包扩展后端 |
| `npm run typecheck:all` | 检查后端、测试与前端 TypeScript 类型 |
| `npm run watch` | 监听并重新打包扩展后端 |
| `npm run dev:frontend` | 启动前端 Vite Dev Server |
| `npm run build` | 构建后端与前端 |
| `npm test -- --runInBand` | 运行后端 Jest 测试 |
| `npm run test:frontend` | 运行前端 Vitest 测试 |
| `npm run test:coverage` | 生成后端测试覆盖率 |
| `npx @vscode/vsce package` | 打包 VSIX |

### 项目结构

```text
Gray-Code/
├── backend/                 # 扩展后端、模型渠道、会话、设置与工具
│   ├── __tests__/           # 后端 Jest 回归测试
│   ├── core/                # 核心服务
│   ├── modules/             # 渠道、配置、会话、MCP、记忆等模块
│   └── tools/               # 内置工具实现
├── frontend/                # Vue 3 + Pinia + Vite Webview 前端
├── webview/                 # VS Code Webview 路由与处理器
├── shared/                  # 前后端共享协议与类型
├── resources/               # 图标、字体、音效与随包资源
├── scripts/                 # 构建、检查与发布脚本
├── test/                    # 跨模块测试与基准测试
├── extension.ts             # VS Code 扩展入口
└── package.json             # 扩展清单、命令、配置与脚本
```

### 提交前检查

请按改动风险选择验证范围；提交 Pull Request 前至少建议运行：

```bash
npm run typecheck:all
npm run build
npm test -- --runInBand
npm run test:frontend
```

如果改动涉及前端交互，请同时在扩展开发宿主中验证对应流程。涉及 i18n、工具声明或生成文件时，请运行仓库已有的对应校验脚本，并确认生成内容已同步。

### 改动原则

- 一个提交聚焦一个功能或修复，避免混入无关格式化。
- Bug 修复应尽量增加能稳定复现问题的回归测试。
- 保留用户已有改动，不使用破坏性 Git 操作覆盖工作区。
- 用户手册放在 [Wiki](https://github.com/Komeiji-Shiki/Gray-Code/wiki)，README 只保留产品入口与快速开始；开发约定和代码结构保留在本文件中。
- 中英文入口或用户可见文案发生变化时，保持对应内容同步。

### Pull Request

PR 描述建议包含：问题背景、实现方式、风险或兼容性影响、验证命令与结果。若改动较大，请按功能模块拆分提交，方便审查和回退。

## English

Thank you for contributing to GrayCode. Use [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) for bug reports and proposals, or open a Pull Request directly.

### Requirements and setup

- VS Code `^1.84.0`
- Node.js 20 or newer
- npm (`package-lock.json` is committed and maintained)

```bash
git clone https://github.com/Komeiji-Shiki/Gray-Code.git
cd Gray-Code
npm ci
npm --prefix frontend ci
```

For the recommended development workflow, select `Run Extension (Local Vite Dev)` in VS Code. It starts the backend watcher and the frontend Vite server. For a manual setup, run `npm run watch` and `npm run dev:frontend` in separate terminals, then launch the extension host.

### Validation

Before opening a Pull Request, run the checks appropriate to the change. The usual full set is:

```bash
npm run typecheck:all
npm run build
npm test -- --runInBand
npm run test:frontend
```

Verify frontend changes in an Extension Development Host. Run the repository's dedicated parity or generation checks when changing localization, tool declarations, or generated files.

### Contribution guidelines

- Keep each commit focused on one feature or fix.
- Add a stable regression test for bug fixes whenever practical.
- Avoid unrelated formatting and destructive Git operations.
- Keep user documentation in the [Wiki](https://github.com/Komeiji-Shiki/Gray-Code/wiki); keep implementation and contributor guidance versioned in this file.
- Keep Chinese and English entry points in sync when user-facing behavior changes.

PR descriptions should explain the problem, implementation, compatibility or risk considerations, and validation results. Split larger changes into functional commits so they remain easy to review and revert.
