# 审计修复批次 T4（F-07 / F-04 / F-11）执行报告

> 计划来源：`.graycode/plans/audit-remediation-修复计划.plan.md`（第四、五组中的本批次范围）
> 参考：`AUDIT_REMEDIATION.md` 第 7、13、14 节与第 15 节实施顺序

## 一、批次现状说明

进入工作区核对后发现，本批次三项修复的核心实现与测试均已存在于仓库已提交历史中
（commit `3bfab33 feat: harden tools and add memory controls`，与上一批次 P2 核对结论一致），
CHANGELOG [Unreleased] 亦已记录对应修复条目。本批次工作为：

1. 逐项核对 F-07 / F-04 / F-11 已提交实现与计划 / AUDIT_REMEDIATION 要求的一致性；
2. 验证通知测试全绿、构建产物不再携带 node-notifier、`npm audit --omit=dev` 归零；
3. 核对两份锁文件 fast-xml-parser 版本一致性。

## 二、修改摘要（核对结论：均已就位，无需重复改动）

### F-07：通知适配器改 VS Code 原生实现 + 移除 node-notifier + esbuild 清理 ✅

- `backend/modules/notifications/WindowsToastAdapter.ts`：
  - 实现 `VSCodeNotificationAdapter implements WindowsToastAdapter`，`show()` 调用
    `vscode.window.showInformationMessage(title, { detail: message, modal: false }, ...actions)`；
  - 不等待用户关闭通知：`show()` 立即返回 `{ shown: true }`，操作按钮结果通过
    `void Promise.resolve(notificationPromise).then(...)` 异步处理，工具调用不挂起；
  - 选择「Open Chat」后异步执行 `request.onClick()`，失败仅记录日志；
  - API 同步抛错由 try/catch 捕获并返回 `{ shown: false, error }`。
- `backend/modules/notifications/WindowsAgentStopNotificationService.ts`：
  - 已改为使用新适配器（import `VSCodeNotificationAdapter`，默认注入 `new VSCodeNotificationAdapter()`）；
  - 保留「打开聊天」行为：`handleNotificationClick()` 通过 `executeCommand('graycode.openChat')` 打开聊天面板。
- `backend/tools/notification/show_windows_notification.ts`：
  - 已使用 `VSCodeNotificationAdapter`（默认适配器），`openChatOnClick` 语义保留
    （`waitForAction` + `onClick` → `graycode.openChat`）。
- `package.json`：`dependencies` 已无 `node-notifier`（现仅 `@vscode/codicons` / `fast-xml-parser ^5.10.1` / `ignore` / `nanoid` / `tree-kill`）。
- `esbuild.config.js`：已无 `nativePackages` 复制逻辑与失效注释，`external` 仅剩 `vscode` / `typescript`。
- 测试（均已提交且在跑）：
  - `backend/__tests__/notifications/windowsToastAdapter.test.ts`：4 项，覆盖 AUDIT 13.7 要求
    （调用原生 API 并立即返回、Open Chat 触发 onClick、无 onClick 不加操作按钮、API 抛错返回 shown:false+错误信息）；
  - `backend/__tests__/notifications/show_windows_notification.test.ts`：5 项
    （声明参数、规范化内容 + openChat、关闭静音/点击打开、非 Windows 平台跳过、空消息拒绝）。

### F-04：`.vscode/launch.json` 替换失效的 `Extension Tests` ✅

- 当前 `launch.json` 已无指向 `dist/test/suite/index` 的失效 `Extension Tests` 配置；
- 已存在与 AUDIT 7.2 建议完全一致的 `Debug Backend Tests (Jest)` 配置：
  `program: ${workspaceFolder}/node_modules/jest/bin/jest.js`，
  `args: ["--config", "jest.backend.config.js", "--runInBand"]`，
  `console: integratedTerminal`，`internalConsoleOptions: neverOpen`；
- 校验可运行性：`jest.backend.config.js` 存在、`node_modules/jest/bin/jest.js` 存在；
- 原有三个扩展运行配置（Run Extension / Playground Worktree / Local Vite Dev）原样保留。

### F-11：同步 package-lock.json 与 pnpm-lock.yaml ✅（无需同步）

- `package-lock.json`：`node_modules/fast-xml-parser` 唯一版本 `5.10.1`，根依赖 `^5.10.1`；
- `pnpm-lock.yaml`：唯一版本 `fast-xml-parser@5.10.1`；
- 两份锁文件版本一致 → 按任务要求记录「无需同步」，**未改动任何 lock 文件**。

## 三、验证结果

```
npx jest --config jest.backend.config.js backend/__tests__/notifications/
Test Suites: 2 passed, 2 total
Tests:       9 passed, 9 total
Snapshots:   0 total
```

- `show_windows_notification.test.ts` PASS（5 项）
- `windowsToastAdapter.test.ts` PASS（4 项）
- `node esbuild.config.js` → `[esbuild] bundle done`（构建成功）
- `npm audit --omit=dev` → `found 0 vulnerabilities`（node-notifier / uuid 生产告警归零，AUDIT 13.8 验收达成）
- `npm ls node-notifier uuid`：node-notifier@10.0.1 仅存在于 jest 开发依赖链
  （jest → @jest/core/@jest/reporters/jest-cli 的可选 peer 依赖），非生产依赖；
  锁文件中相应条目为 `dev:true / optional:true / peer:true`，属正确保留，不满足移除条件。
- `dist/` 构建产物无 `node-notifier` / `uuid`（AUDIT 13.7.6 验收达成）。

## 四、边界与合规

- 本批次核对后未修改任何仓库文件（三项修复均已就位且符合要求，重复改动无意义）；
- 未修改：CHANGELOG.md（主模型统一记录）、规划文档、backend/tools/subagents/、
  checkpoint / conversation / frontend / webview（其它批次/其它 agent 的文件）；
- lock 文件未改动（版本一致，按任务要求不动的场景）。

## 五、观察与建议（不在本批次范围）

- `.tmp/check_runtime_load.js`（gitignored、未跟踪）是修复前为验证
  `dist/node_modules/node-notifier` 加载链路创建的运行时探针，已随 F-07 失效；
  因其不在本批次文件边界内且不影响仓库/构建产物，未删除，可随时本地清理。
