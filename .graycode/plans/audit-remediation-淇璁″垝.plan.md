## TODO LIST

<!-- GRAYCODE_TODO_LIST_START -->
- [x] F-01: xmlFormatter.ts 加 XMLParser 防御配置（processEntities/maxNestedTags）  `#P1`
- [x] F-03: 更新 XML 指南示例与 xmlFormatter/promptToolParser 测试夹具  `#P2`
- [x] F-02: 重构 toolResponseFormatter.ts 部分成功序列化 + 新增测试  `#P3`
- [x] F-04: launch.json 替换为 Jest 调试配置  `#P4`
- [x] F-05: 修复 SubAgentRegistry.isEnabled() + 新增 registry 测试  `#P5`
- [x] F-08: 自定义 executor 正式生效 + SubAgentRequest 动态上下文字段  `#P6`
- [x] F-06/F-09: 接续会话归属校验 + 持久化快照恢复  `#P7`
- [x] F-10: ChannelManager/ToolDeclarationResolver 统一 General Worker 可用性判断  `#P8`
- [x] F-07: 通知适配器改 VS Code 原生实现 + 移除 node-notifier + esbuild 清理  `#P9`
- [x] F-11: 同步 package-lock.json 与 pnpm-lock.yaml  `#P10`
- [x] 全量验证: typecheck / Jest / Vitest / build / npm audit  `#P11`
- [x] 更新 CHANGELOG.md [Unreleased] 与 AUDIT_REMEDIATION.md 状态  `#P12`
<!-- GRAYCODE_TODO_LIST_END -->

# AUDIT_REMEDIATION 修复计划

依据 `AUDIT_REMEDIATION.md` 第 15 节建议的实施顺序，分五组执行。

## 第一组：XML 安全与协议正确性（F-01、F-03、F-11）

1. `backend/tools/xmlFormatter.ts`：XMLParser 增加 `processEntities: false`、`maxNestedTags: 100`，保留原有字符串语义配置。
2. 更新 `read_file`/`write_file` 的 XML 模式指南示例（去掉 `paths`、`files` 过时形状）。
3. `backend/__tests__/tools/xmlFormatter.test.ts`、`promptToolParser.test.ts`：更新夹具为真实 schema，补安全输入测试（DOCTYPE 实体不展开、超深嵌套拒绝、`__proto__` 原型污染）。
4. 同步 `package-lock.json` 与 `pnpm-lock.yaml`（fast-xml-parser@5.10.1 一致）。

## 第二组：LLM 工具结果序列化（F-02）

1. `backend/modules/channel/formatters/toolResponseFormatter.ts`：重构 `serializeToolResultForLLM()`，错误分支不再丢弃 `data`；`data.results` 混合数组逐项格式化；保留 `data.output`、`data.message`、批量统计字段与取消标记。
2. 新增 `backend/__tests__/channel/toolResponseFormatter.test.ts` 覆盖文档 5.6 节 10 项要求。

## 第三组：Sub-Agent 正确性与会话边界（F-05、F-06、F-08、F-09、F-10）

1. `registry.ts`：修复 `isEnabled()`；`get()`/`getByName()` 不再隐式缓存默认 executor。
2. `types.ts`：`SubAgentRequest` 增加 `conversationId`、`conversationStore`、`promptModeSnapshot` 动态上下文。
3. `subagents.ts`：正式调用路径优先使用显式注册的自定义 executor，传递动态上下文。
4. `executor.ts`：接续时先查内存快照，未命中且当前对话有 store 时只加载当前对话持久化快照；执行 conversationId 归属校验后再创建新 run。
5. `ChannelManager.ts` / `ToolDeclarationResolver.ts`：统一 General Worker 可用性判断（`countEnabled() > 0 || generalWorkerEnabled !== false`）。
6. 新增 `backend/__tests__/tools/subagentRegistry.test.ts`，更新 `subagentsTool.test.ts` 及接续相关测试。

## 第四组：通知依赖与构建清理（F-07）

1. `WindowsToastAdapter.ts`：改为 VS Code 原生通知实现（`vscode.window.showInformationMessage`），异步处理操作按钮，不阻塞工具调用。
2. `WindowsAgentStopNotificationService.ts`、`show_windows_notification.ts`：改用新适配器，保留打开聊天行为。
3. `package.json` 移除 `node-notifier` 直接依赖；`esbuild.config.js` 删除 native package 复制逻辑与失效注释。
4. 更新 `backend/__tests__/notifications/show_windows_notification.test.ts`。

## 第五组：开发体验与最终验证（F-04、F-11）

1. `.vscode/launch.json`：用可运行的 Jest 调试配置替换失效的 `Extension Tests`。
2. 执行 `npm run typecheck`、后端 Jest、前端 Vitest、完整构建、`npm audit --omit=dev`。
3. 更新 `CHANGELOG.md` 的 [Unreleased] 小节记录全部修改。
4. 更新 `AUDIT_REMEDIATION.md` 中各项状态为已完成并附验证结果。
