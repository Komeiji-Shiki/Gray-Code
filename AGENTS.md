# AGENTS.md

给在本仓库工作的 AI 编码助手与贡献者：技术栈、目录、命令、修改约束与禁止事项。架构见 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)，环境、验证与打包见 [CONTRIBUTING.md](CONTRIBUTING.md)，用户手册见 [wiki/Home.md](wiki/Home.md)。

## 项目速览

- **GrayCode** 是本地优先的 AI 工作台。`main` 是 2.x 独立平台（Electron 桌面 + Web 服务）；1.x VS Code 扩展在 `v1-extension` 分支，`main` 只保留扩展的构建入口（`webview/`、`extension.ts`、根 `npm run build`）。
- **技术栈**：TypeScript；Node.js ≥ 24.11（与 Electron 内置的 Node 24 一致，主版本记录在 `.nvmrc`）；npm；Electron、Vue 3（Pinia）、esbuild、Jest、Vitest、MCP SDK。
- **原生**：`native/windows/ComputerHost` 是 .NET Framework 4 的 C# 电脑操作宿主，由 `scripts/build-computer-host.mjs` 调用系统自带的 csc.exe 构建；桌面发行面向 Windows x64。
- **语言**：文档与提交信息用中文（英文入口是 `README_EN.md`）。

## 目录速览

| 路径 | 职责 |
| --- | --- |
| `packages/contracts` | 跨端数据结构与 RPC 契约 |
| `packages/core` | 运行核心：模型/工具循环、内容存储、历史与记忆索引 |
| `apps/server` | 模型适配、提示词、工作区、Git、终端、MCP、ACP、Bot、节点、自动任务 |
| `apps/desktop` | Electron 组合根、窗口、内置浏览器、电脑捕获、安装更新 |
| `apps/client` | 桌面/Web 外壳：文件树、编辑器、面板与远程控制界面 |
| `frontend` | 聊天、设置、角色与工具结果界面（独立 package.json 与锁文件） |
| `backend` | 仍被平台复用的业务模块（MCP、配置、提示词等）、共享工具实现与语言包 |
| `shared` | 跨宿主聊天协议、外观色板与其他纯函数 |
| `webview/`、`extension.ts` | 保留的 VS Code 宿主入口；独立桌面不从这里启动 |
| `native/windows/ComputerHost` | Windows 电脑操作宿主（C#） |
| `fast-tavern-main` | 独立的提示词引擎（`npm-fast-tavern` 与 `py-fast-tavern` 两套实现） |
| `scripts/` | 构建、打包、冒烟验证、i18n 同步、工具元数据生成与检查 |
| `wiki/` | 随源码维护的用户手册 |

## 常用命令

```powershell
npm ci                          # 根依赖（工作区 packages/*、apps/*）
npm --prefix frontend ci        # frontend 有独立锁文件，必须单独安装
npm run build:desktop           # 完整构建：平台 + 桌面 + apps/client + frontend，最后检查渲染体积
npm run desktop -- --data .tmp/desktop-local   # 本机运行桌面（用隔离数据目录）
npm run build:platform          # 只构建平台（core、server、CLI 与工作线程）
npm run platform -- --help      # 独立 CLI 帮助
npm run typecheck:all           # 全仓类型检查
npm test                        # backend 的 Jest 回归
npm --prefix frontend test      # frontend 的 Vitest 回归
npm run test:platform           # core 与 server 集成测试（会先构建平台）
npm run ci                      # 提交前全量检查：类型、backend/frontend 测试、平台集成、提示词引擎（需要 Python）、i18n
npm run i18n:check              # 语言包生成物防漂移校验
npm run license:check           # 工作区许可副本检查（不在 npm run ci 里，打包时会跑）
npm run package:desktop         # 生成桌面便携包（要求已提交的干净源码）
npm run package:installer       # 从便携输出生成安装与更新交付物
```

根 `npm run build` 是保留的 VS Code 扩展构建；独立桌面用 `build:desktop` / `desktop`。

## 修改边界

- **core 不依赖宿主**：`packages/core` 不导入 Electron、VS Code、frontend、webview 或 backend；宿主能力经应用服务与端口注入。`scripts/build-platform.mjs` 构建时检查这条边界，越界直接报错。
- **shared 不用 DOM 类型**：`shared/` 除了被前端与外壳打包，也由根 tsconfig（ES2020、无 DOM 库）检查；需要操作页面元素时用结构类型描述用到的属性。
- **contracts 全链路**：新增字段时同步检查写入、读取、列表、备份恢复与旧数据读取。
- **模型请求保持稳定**：维持既有消息与图片顺序，新增输入不删除旧图；改变工具目录、系统提示或压缩边界时，说明它对请求前缀（缓存命中）的影响。
- **存储格式向后兼容**：格式变更保持旧记录可读；优化时沿用既有结构与读取路径，不另建平行存储。
- **受管进程**：只停止自己启动并持有的子进程；按 PID 操作前先确认仍是同一个进程，停止时只结束自己的进程树。
- **避免多余抽象**：不新建只做转发或改名的包装层；已有正式依赖（如 MCP SDK）实现的协议，不再自己实现一份。
- **风格跟随现状**：命名、错误处理与日志沿用所在目录的既有模式，不为一次改动引入新的风格体系。
- **注释写原因与边界**，不复述代码表面含义。

## 前端与 i18n

- `frontend/`、`apps/client/` 下可能有本机的 `AGENTS.md`（已在 `.gitignore` 中，记录 UI 参考截图），存在时先读。
- **视觉**：暗色为主、平面；结构（标题栏、侧栏、分栏、标签栏）直角，部件小圆角（用 `--gc-radius-*`）。区域之间靠留白与明暗分隔，少画线：分割线用 `--gc-border-subtle`，输入框与按钮描边用 `--gc-border-control`。组件样式只引用 `--gc-*` 语义 token，色值只在 `shared/appearance.ts` 定义。
- **界面行为**：设置只有一个入口；切换对话模式不新建对话；文件树在自己的面板里滚动，不把整个应用撑高。
- **文案走 i18n**：共享词条以 `backend/i18n/langs/` 为单一来源，映射登记在 `scripts/i18n-shared-manifest.json`，生成物 `frontend/src/i18n/langs/_shared/` 不可手改；改完运行 `node scripts/i18n-sync.mjs`（校验用 `npm run i18n:check`）。
- **工具展示元数据**以 `backend/tools` 的 ToolDeclaration 为单一来源，生成到 `frontend/src/utils/tools/__generated__/toolMeta.ts`，不可手改；重新生成用 `node scripts/generate-tool-meta.mjs`。

## Never（禁止事项）

出现新的踩坑时在这里补一条。

- Never 手改生成物与产物：`frontend/src/i18n/langs/_shared/**`、`frontend/src/utils/tools/__generated__/**`、`dist/**`、打包输出——改源头，然后跑生成脚本。
- Never 提交本机文件与数据：`.tmp/`（含 UI 参考截图）、`.graycode/`、`release/`、`platform-data/`、`portable-data/`、`.env*`、`*.vsix`、根 `docs/`、`report.md` 及根目录本地计划/反馈类 Markdown；完整名单以 `.gitignore` 为准。
- Never 在组件中直接引用 `--vscode-*`、外壳旧变量或写死色值——新增颜色角色先加到 `tokens.css` 与色板。
- Never 使用 yarn / pnpm 安装依赖或提交其他锁文件（项目用 npm，`pnpm-lock.yaml` 已被忽略）。
- Never 放宽或绕过既有检查（tsconfig、测试、`i18n:check`、`license:check`）；检查不过先修原因，不要改检查。
- Never 执行会丢弃他人未提交改动的 git 操作（`reset --hard`、`checkout -- .`、`clean -fdx`、强制推送）。
- Never 提交密钥、令牌或含密钥的配置；密钥放本机设置或环境变量。
- Never 把本机绝对路径、个人笔记写进将提交的文件；临时脚本放 `.tmp/` 或用完即删。
- Never 顺手整文件重排或格式化无关代码；缩进与引号跟随所在文件既有风格。

## 验证

- 开发中只做必要的快速检查，改完后集中跑回归；条件没变时不重复跑已经通过的整套检查。
- 测试位置：`backend/__tests__/`（根 Jest）、`packages/core/tests/`（平台 Jest）、`frontend/src` 下的测试目录（Vitest）。
- 按改动范围选择命令：
  - 类型：`npm run typecheck:all`
  - backend：`npm test`；frontend：`npm --prefix frontend test`
  - 平台集成：`npm run test:platform`；提示词引擎：`npm run test:fast-tavern-ts`、`npm run test:fast-tavern-py`
  - 提交前：`npm run ci`
- 定向示例：

```powershell
npx jest --config jest.platform.config.cjs --runInBand packages/core/tests/externalAgents.test.ts
npm --prefix frontend test -- src/__tests__/components/StaticGuards.test.ts
```

- **真实流程**：类型与组件测试不能代替真实流程。桌面改动先 `npm run build:desktop`，再运行 `npx electron scripts/smoke-desktop.cjs`：它用隔离数据目录和合成模型端点覆盖启动、发送与工具循环、审批、重生成与分支切换、编辑器、设置、截图和退出，报告与截图写到 `.tmp/desktop-smoke-*`（`GRAYCODE_SMOKE_OUTPUT` 只能指向 `.tmp/` 下以 `desktop-smoke-` 开头的目录）。改动涉及脚本没覆盖的场景（如取消运行、工作树）时再手动跑一遍。浏览器交互用 `node scripts/smoke-browser.cjs`。MCP/ACP 测试使用真实本机 stdio/HTTP 夹具，只关闭自己启动的子进程。
- **CI**：`ci.yml` 在 PR 与 `main` 推送时，在 Ubuntu 上跑 `npm run ci`，在 Windows 上构建桌面并跑进程生命周期、真实 MCP 夹具与 `smoke-desktop.cjs`；`desktop.yml` 手动触发，打包便携版与安装包；`nightly-build.yml` 与 `release.yml` 只构建 1.x VSIX，2.x 会跳过。

## 提交与协作

- 提交信息用中文描述改动本身，按「一个可独立说明的阶段」组织；目录移动与行为修改尽量分开提交。
- 多会话并行时保持改动范围清晰，不做顺手的全仓重命名或格式化。
- 向仓库提交贡献时按 DCO 1.1 使用 `git commit -s`；新贡献默认 AGPL-3.0-only 并含限定的 Cubism 例外（见 [LICENSING.md](LICENSING.md)）。
- 用户可感知的变化按批次补记 `CHANGELOG.md`。
- 新增第三方依赖：保留原始许可，并按 `resources/licenses/README.md` 记录来源。
- 文档各归其位：README 面向用户入口，`wiki/` 是手册，PROJECT_STRUCTURE.md 讲架构，CONTRIBUTING.md 讲流程；行为变化同步更新对应文档。
- 完成后的说明写清：解决了什么问题、最终行为、做过哪些验证、数据格式是否兼容、还有哪些环境限制。
