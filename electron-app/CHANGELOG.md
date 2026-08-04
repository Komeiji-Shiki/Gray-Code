# Change Log (GrayCode Desktop)

本文件记录 GrayCode Desktop（Electron 独立桌面版）的变更。
桌面版基于 GrayCode VS Code 插件 v1.3.1 的 backend/webview 代码复用构建；
插件本体（backend / frontend 公共部分 / webview）的变更见根目录 `CHANGELOG.md`。

This file tracks changes to the GrayCode Desktop (standalone Electron edition).
Changes to the shared plugin codebase (backend / webview / shared frontend)
are tracked in the root `CHANGELOG.md`.

## [Unreleased]

### Added
  - 变更查看面板（Diff Viewer）：由全屏模态框改为**主窗口内嵌 GitHub 风格面板**（右侧抽屉，非独立窗口，运行逻辑与 SubAgent Monitor 内嵌面板一致）。`vscode.diff` 拦截 → `host.openDiffPreview` 命令 → 打开面板：左侧文件列表（状态徽标 + ±行数统计），右侧统一 diff（hunk 头 `@@ -a,b +c,d @@` + 双行号 + 增删着色），支持单文件/全部接受与拒绝、删除警戒提示、`diff.statusChanged` 状态同步；accept/reject 复用 VS Code 版同一协议（`electron-app/renderer/overlay.js` 的模态框已移除）
  - 行级 diff 算法抽取为公共工具 `frontend/src/utils/diffLines.ts`（LCS 行匹配 + hunk 分组 + 统计），write_file 工具卡改用它，删除重复实现；配套 Vitest 12 例
  - UISMOKE 新增 `diffPanel` 步骤：命令打开面板 → 断言文件列表/增删行/hunk 头 → 关闭按钮收起（防回归）
  - 新增快速启动脚本：`start.bat`（Windows）/ `start.sh`（macOS/Linux）——按需安装依赖并增量构建，双击或一条命令即可启动；`--rebuild` 参数强制全量重建
  - 子代理 Monitor 改为主窗口内嵌面板（右侧分区，替代独立 BrowserWindow）：不再占用任务栏；顶部栏新增 Monitor 开关按钮，工具卡「打开详情」直接聚焦对应 run；面板可折叠，折叠时后端自动停止推送高频流式事件（llm_delta 50ms 合并节流，重新打开按 revision 校准）
  - 顶部栏常驻化：无标签页时显示 GrayCode 占位标题，右侧固定「SubAgent Monitor 开关 / 语言切换 / 设置齿轮」，语言在 简体中文 → English → 日本語 → Auto（跟随系统）间循环并持久化
  - 日文语言包接入全部工具卡/终端组件（旧 i18n 链路补齐 ja 与 auto 解析）；「跟随系统」模式接线系统语言检测
  - 首次运行引导（Welcome / 配置 API 渠道）只显示一次：已显示过或已配置真实 Key 后不再弹出（持久化标记）

### Fixed
  - 修复设置齿轮与语言切换按钮缺失（多次回归根因：顶部栏被回退为上游版本）；改为常驻渲染后 UI 冒烟测试稳定
  - 修复 `showQuickPick` 丢弃 options 且 `canPickMany` 返回形状错误（Diff 多块选择 `selected.some is not a function` 崩溃）：options 转发渲染层，多选返回数组
  - 修复后端自动打开的 Diff 预览左栏恒空：`vscode.diff` 的 `gemini-diff-original:` 分支经 `resolveOriginalContent` 从 DiffManager 实况补取原始内容
  - 修复 glob 花括号 `{a,b}` 永不匹配（`find_files` 的 exclude 规则全部失效）；重构为未锚定正则拼接
  - 修复 `findFiles` 并发遍历饿死深层目录与多工作区同相对路径互相吞结果：8 路并发 + 空队列不推进游标 + 去重键改绝对路径
  - `workspace.fs.readFile` 改为零拷贝 Buffer 视图，大文件读取不再产生整份复制

## [1.3.1] - 2026-08-03

### Added
  - Electron 独立桌面版首版：完整复用 GrayCode v1.3.1 后端（渠道/对话/工具/diff/MCP/子代理/检查点/记忆/技能/用量）与 Vue3 前端，脱离 VS Code 运行
  - `vscode` API 兼容层（`vscode-shim.ts`）：Uri / workspace.fs / 配置 / 对话框 / diff 命令 / findFiles / openTextDocument / 主题等，esbuild alias 内联进主进程 bundle
  - `graycode://` 自定义协议服务前端与资源（MIME 表 + mtime 内存缓存），规避 `file://` 的 fetch/audio CORS 限制
  - Diff 预览模态框（接受/拒绝/逐块），`vscode.diff` 命令拦截 + sessionId 异步解析（3s 轮询兜底）
  - Overlay：toast / quickPick / inputBox / 无工作区提示 / 首次运行 Welcome（DOM-ready 守卫）
  - 多语言 UI（简体中文 / English / 日本語）+ 顶部栏新建标签 / 语言切换 / 设置齿轮
  - 首次运行引导与无工作区提示；工作区选择与持久化、失效目录自动降级提示
  - 子代理 Monitor 独立窗口版（后续版本已改为内嵌面板）；run 卡片「继续」按钮与前后台任务状态回流
  - 打包：electron-builder（win NSIS/zip、mac dmg/zip、linux AppImage/deb）+ GitHub Actions 三平台 CI
  - 测试体系：后端 E2E（7 场景 40+ 断言）、UI 冒烟（UISMOKE）、MONITOR_SMOKE、mock MCP 服务器

### Fixed
  - 修复「无法打开项目文件夹」：WorkspaceFolder 补 `fsPath` 字段 + `Uri.toString()` 输出标准 `file:///` 格式
  - 修复 macOS activate 重复注册 IPC 导致消息执行两次
  - 修复 overlay.js 在 body 就绪前执行导致 appendChild 报错（DOM-ready 守卫）
  - 修复自定义协议 MIME 缺失/大小写敏感路径校验（Windows 路径归一化）
  - 修复 diff 预览右栏恒空与 sessionId 失效（两种 diff 路径分别处理）
  - 修复 findFiles 默认跳过 dist/build 导致 AI 无法检查构建产物（改为设置可覆盖）
  - 修复 workspaceState/globalState 导出 null（JSON 文件持久化）
  - 修复 `require('./vscode-shim')` 打包后必崩（改为具名导入）
