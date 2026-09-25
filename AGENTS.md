# AGENTS.md

本文件面向在此仓库工作的 AI 编码助手与人类贡献者，约定技术栈、目录边界、常用命令、修改约束与禁止事项。更完整的背景与流程见：[PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)（架构与依赖边界）、[CONTRIBUTING.md](CONTRIBUTING.md)（环境、验证与打包）、[wiki/Home.md](wiki/Home.md)（用户手册）。

## 项目速览

- **GrayCode** 是本地优先的 AI 工作台：`main` 维护 2.0 独立平台（Electron 桌面 + Web 服务）；1.x VS Code 扩展源码在 `v1-extension` 分支，仓库仍保留扩展构建入口，但与桌面路径分开。
- **技术栈**：TypeScript；Node.js ≥ 22.15；npm；Electron、Vue 3（Pinia）、esbuild、Jest、Vitest、MCP SDK。
- **原生**：`native/windows/ComputerHost` 是 .NET Framework 4 的 C# 电脑操作宿主，用 Windows 自带的 csc.exe 构建；桌面发行面向 Windows x64。
- **语言**：仓库文档与提交信息使用中文（`README_EN.md` 是英文入口）。

## 目录速览

| 路径 | 职责 |
| --- | --- |
| `packages/contracts` | 跨端数据与首批 RPC 契约 |
| `packages/core` | 运行核心：模型/工具循环、内容存储、历史与记忆索引 |
| `apps/server` | 模型适配、提示词、工作区、Git、终端、MCP、ACP、Bot、节点、自动任务 |
| `apps/desktop` | Electron 组合根、窗口、内置浏览器、电脑捕获、安装更新 |
| `apps/client` | 桌面/Web 外壳：文件树、编辑器、面板与远程控制界面 |
| `frontend` | 聊天、设置、角色与工具结果界面（独立 package.json 与锁文件） |
| `backend` | 仍被平台复用的业务模块（MCP、配置、提示词等）、共享工具实现与语言包 |
| `shared` | 跨宿主聊天协议、纯函数与共享逻辑 |
| `webview/`、`extension.ts` | 保留的 VS Code 宿主入口；独立桌面不从该入口启动 |
| `native/windows/ComputerHost` | Windows 电脑操作宿主（C#） |
| `fast-tavern-main` | 独立的提示词引擎（TypeScript 与 Python 两套） |
| `scripts/` | 构建、打包、i18n 同步、工具元数据生成与检查 |
| `wiki/` | 随源码维护的用户手册 |

## 常用命令

```powershell
npm ci                          # 根依赖（工作区 packages/*、apps/*）
npm --prefix frontend ci        # frontend 有独立锁文件，必须单独安装
npm run build:desktop           # 完整构建：平台 + 桌面 + apps/client + frontend
npm run desktop -- --data .tmp/desktop-local   # 本机运行桌面（用隔离数据目录）
npm run build:platform          # 只构建平台（core、server、CLI 与工作线程）
npm run platform -- --help      # 独立 CLI 帮助
npm run typecheck:all           # 全仓类型检查
npm test                        # backend 的 Jest 回归
npm --prefix frontend test      # frontend 的 Vitest 回归
npm run test:platform           # core 与 server 集成测试（会先构建平台）
npm run ci                      # 提交前全量检查：类型、测试、i18n、提示词引擎
npm run i18n:check              # 语言包生成物防漂移校验
npm run license:check           # 工作区许可副本检查
npm run package:desktop         # 生成桌面便携包（要求已提交的干净源码）
npm run package:installer       # 从便携输出生成安装与更新交付物
```

注意：根 `npm run build` 是保留的 VS Code 扩展构建；独立桌面的构建与运行用 `build:desktop` / `desktop`。

## 修改边界

- **core 不依赖宿主**：`packages/core` 不导入 Electron、VS Code、frontend、webview 或 backend；宿主能力经应用服务与端口注入，构建脚本会检查该边界。
- **contracts 全链路**：新增字段时同步检查写入、读取、列表、备份恢复与旧数据读取。
- **模型请求保持稳定**：维持既有消息与图片顺序，新增输入不删除旧图；改变工具目录、系统提示或压缩边界时，说明其对请求前缀的影响。
- **存储格式向后兼容**：格式变更保持旧记录可读；优化时沿用既有结构与读取路径，不另建平行存储。
- **受管进程**：只按自己持有的对象处理子进程，先确认真实身份，停止时只作用于持有的进程树。
- **避免多余抽象**：不为目录名称建立新的包装层；领域内的重复协议实现优先交给已有正式依赖。
- **风格跟随现状**：命名、错误处理与日志沿用所在目录的既有模式，不为一次改动引入新的风格体系。
- **注释写原因与边界**，不复述代码表面含义。

## 前端与 i18n

- 修改 `frontend/` 或 `apps/client/` 前，先查看所在目录的 `AGENTS.md`（若存在；这类本机文件记录 UI 参考截图，不进入 Git）；改动保持暗色、平面、直角风格，设置保留单一入口，模式切换不新建对话，文件树不撑高整个应用。
- 用户可见文案走 i18n：共享词条以 `backend/i18n/langs/` 为单一来源，映射登记在 `scripts/i18n-shared-manifest.json`，生成物 `frontend/src/i18n/langs/_shared/` 不可手改；改完后运行 `node scripts/i18n-sync.mjs`（校验用 `npm run i18n:check`）。
- 工具展示元数据以 `backend/tools` 的 ToolDeclaration 为单一来源，生成到 `frontend/src/utils/tools/__generated__/toolMeta.ts`，不可手改；重新生成用 `node scripts/generate-tool-meta.mjs`。

## Never（禁止事项）

本节每条都应能在 diff 里对上号；出现新的踩坑，就补一条到这里。

- Never 手改生成物与产物：`frontend/src/i18n/langs/_shared/**`、`frontend/src/utils/tools/__generated__/**`、`dist/**`、打包输出——改源头，然后跑生成脚本。
- Never 提交本机文件与数据：`.tmp/`（含 UI 参考截图）、`.graycode/`、`release/`、`platform-data/`、`portable-data/`、`.env*`、`*.vsix`、根 `docs/`、`report.md` 及根目录本地计划/反馈类 Markdown；完整名单以 `.gitignore` 为准。
- Never 在 `packages/core` 引入宿主依赖（Electron / VS Code / 界面目录）。
- Never 未做全链路检查就给 `packages/contracts` 加字段。
- Never 打乱模型请求的消息与图片顺序，或丢弃历史图片。
- Never 使用 yarn / pnpm 安装依赖或提交其他锁文件（项目用 npm，`pnpm-lock.yaml` 已被忽略）。
- Never 放宽或绕过既有检查（tsconfig、测试、`i18n:check`、`license:check`）；检查不过先修原因，不要改检查。
- Never 执行会丢弃他人未提交改动的 git 操作（`reset --hard`、`checkout -- .`、`clean -fdx`、强制推送）；只提交自己改动的文件。
- Never 提交密钥、令牌或含密钥的配置；密钥放本机设置或环境变量。
- Never 把本机绝对路径、个人笔记写进将提交的文件；临时脚本放 `.tmp/` 或用完即删。
- Never 顺手整文件重排或格式化无关代码；缩进与引号跟随所在文件既有风格。

## 验证

- 开发中只做必要的快速检查，主要回归在修改完成后集中执行；相同条件已经通过的检查，不要重复整套。
- 测试位置：`backend/__tests__/`（根 Jest）、`packages/core/tests/`（平台 Jest）、`frontend/src` 下的测试目录（Vitest）。
- 按改动范围选择命令：
  - 类型：`npm run typecheck:all`
  - backend：`npm test`；frontend：`npm --prefix frontend test`
  - 平台集成：`npm run test:platform`；提示词引擎：`npm run test:fast-tavern-ts`、`npm run test:fast-tavern-py`
  - 提交前：`npm run ci`
- CI：PR 与 main 推送跑 `npm run ci`；桌面构建（Windows runner）、nightly 与 release 由各自工作流负责。
- 定向示例：

```powershell
npx jest --config jest.platform.config.cjs --runInBand packages/core/tests/externalAgents.test.ts
npm --prefix frontend test -- src/__tests__/components/StaticGuards.test.ts
```

- 类型与组件测试不能代替真实流程：受影响的桌面场景用隔离数据目录和合成模型端点实际跑一遍（启动、发送、编辑、重生成、确认、取消、设置、截图、工作树、退出）。MCP/ACP 测试使用真实本机 stdio/HTTP 夹具，只关闭自己启动并持有的子进程。

## 提交与协作

- 提交信息用中文描述改动本身，按「一个可独立说明的阶段」组织；目录移动与行为修改尽量分开提交。
- 多会话并行时保持改动范围清晰：只提交自己改动的文件，不做顺手的全仓重命名或格式化。
- 向仓库提交贡献时按 DCO 1.1 使用 `git commit -s`；新贡献默认 AGPL-3.0-only 并含限定的 Cubism 例外（见 [LICENSING.md](LICENSING.md)）。
- 用户可感知的变化按批次补记 `CHANGELOG.md`。
- 新增第三方依赖：保留原始许可，并按 `resources/licenses/README.md` 记录来源。
- 文档各归其位：README 面向用户入口，`wiki/` 是手册，PROJECT_STRUCTURE.md 讲架构，CONTRIBUTING.md 讲流程；行为变化同步更新对应文档。
- 收尾说明：问题、最终行为、相关验证、数据格式兼容性、剩余环境限制。
