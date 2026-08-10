# 已知问题与设计决定清单

> 来源：2026-08-04 多轮全仓扫描（38+ 子代理，约 140 项发现，已修复 ~90 项）后仍存留的问题，
> 以及有意保留的设计决定（供后续维护者参考，避免误改）。
>
> 已修复项见 CHANGELOG.md [Unreleased] 三个批次条目。

---

## 一、未修复问题（低危 / 需决策）

### 1. FileSystemStorageAdapter 会话 ID 未校验
- **位置**：`backend/modules/conversation/storage.ts`（`getConversationDir` 等 `Uri.joinPath` 拼接）
- **问题**：conversationId 未做白名单校验直接拼路径。BranchGraphRepository / DiffStorageManager 已加 `/^[a-zA-Z0-9_-]+$/` 校验，此适配器未覆盖（最小范围原则留待评估）
- **风险**：低——会话 ID 目前均由内部生成（`conv_` 前缀），但 webview/IPC 入口若传入不可信 ID 存在路径逃逸面
- **建议**：入口统一校验会话 ID（与其它两处对齐）

### 2. history_search 正则 ReDoS
- **位置**：`backend/tools/history/history_search.ts:232`
- **问题**：模型提供的正则直接 `new RegExp` 逐行执行，无长度/复杂度限制，病态回溯（如 `(a+)+$`）在超长行上可造成明显卡顿
- **建议**：与 `search_in_files` 对齐——限制正则源长度（500 字符）并捕获构造异常给可读错误

### 3. WindowsAgentStopNotificationService 去重竞态
- **位置**：`backend/modules/notifications/WindowsAgentStopNotificationService.ts:388-428`
- **问题**：去重是"先查后记"且 `rememberDedupe` 在 `showToast` 之后，两个并发相同 dedupeKey 的通知可同时通过检查产生重复 toast
- **建议**：检查前同步写入 dedupe 表（或对 notify 加互斥）

### 4. xmlFormatter 非法键名整体降级丢参数
- **位置**：`backend/tools/xmlFormatter.ts:246-263, 288-327`
- **问题**：顶层参数名含非法 XML 元素名时整体降级为 `<parameters>` 内 CDATA JSON 文本，`parseToolUseNode` 解析回来时该文本落在 `#text` 键被跳过，历史重放的工具调用参数静默丢失
- **风险**：低概率触发（需模型产出非法参数名）
- **建议**：对非法键名逐键转义为合法元素名（或 base64/占位键映射）而非整体降级，保证可逆

### 5. MarkdownRenderer 流式重复全量解析
- **位置**：`frontend/src/components/common/MarkdownRenderer.vue:1067-1119`
- **问题**：流式渲染对每条消息的完整累积内容反复 markdown-it 解析 + sanitize DOM 遍历（约每 120-180ms 一次），长消息总成本接近 O(n²)
- **建议**：增量渲染（保留上次 HTML 尾部追加）或限制重建频率；前端渲染改动风险高，需配合基准验证

### 6. esbuild.config.js external typescript 死配置
- **位置**：`esbuild.config.js:15-18`
- **问题**：external 声明了 `'typescript'`，但全仓库运行时源码无任何 `typescript` import；一旦未来某模块 `require('typescript')` 且 node_modules 不入包（.vscodeignore:66），打包产物将运行时崩溃
- **建议**：移除该 external（或确需时把 typescript 移入 dependencies）

### 7. activationEvents 使用 onStartupFinished
- **位置**：`package.json:19-21`
- **问题**：每次启动 VS Code 都会激活扩展并触发完整初始化（含后端初始化/历史迁移），未使用聊天面板的用户也承担启动开销
- **建议**：改为按需激活（视图/命令触发）或将重初始化延后到 `resolveWebviewView` 首次调用；改动需验证激活时序

### 8. jest / vitest 双测试框架无归属约定
- **位置**：`test/unit/`（jest）与 `frontend/src/__tests__/`（vitest）
- **问题**：前端测试分散两套框架，新增用例易放错位置导致漏跑
- **建议**：明确"前端测试统一走 vitest、test/unit 仅存后端/纯逻辑"约定，逐步迁移 test/unit/frontend

### 9. design / plan pathUtils 收敛
- **位置**：`backend/tools/design/pathUtils.ts`、`backend/tools/plan/pathUtils.ts`
- **问题**：与 progress/review 同构的独立副本（仅 validator 与函数名不同），可统一指向 `progress/pathUtils.ts` 的 `isProgressArtifactPathAllowedWithMultiRoot('design' | 'plan', …)`
- **性质**：纯重构零风险，随时可做（review 6 处已完成同类收敛）

---

## 二、有意保留的设计决定（勿误改）

1. **handleRerollStream / handleEditAndRetryStream 保留内联前置清理**
   `ChatFlowService.ts`：这两个入口的 try 同时包裹业务主体（startReroll / checkpoint 创建删除等），中断标记需跨业务主体保持（finally 才复位），与 `prepareConversationForRequest`（清理即复位）语义不同，故未统一。

2. **SubAgentTranscriptRepository.saveContents 保持返回 void**
   `runEventBus.replaceContents` 会为每条消息补 `index`/`timestamp`，落盘形态 ≠ 传入数组，写后回读是必要语义；且 SubAgent 为内存快照，回读无 IO 成本。

3. **IStorageAdapter.saveHistory 签名未改**
   被 3 个适配器（Memory / VSCode / FileSystem）+ 测试 fake 实现，侵入过大；已通过委托层返回落盘形态获得同等收益（结构性变更 3 次 IO → 2 次）。

4. **runToolLoop 每迭代 getHistoryRef**
   `messageIndex = length - 1` 的正确性依赖该读；改传参需动 ConversationManager 公共 API，超出最小改动。

5. **createModelMessageCheckpoint 每迭代读**
   受 checkpoint 配置开关控制，属独立路径。

6. **diffManager.ts 的 readFileSync**
   读取的是 pendingDiff 的磁盘内容（用户审阅/自动保存路径），非模型直接指定任意路径的输入，风险面不同。

7. **ChannelManager 手拼 `mcp__`**
   已符合 mcpToolNameCodec 的 `mcp__` 约定（与 `encodeMcpToolName` 输出逐字符相同），无需改动。

8. **MemoryManager.loadConfig parseInt 静默回退**
   启动期读本地配置文件，`parseInt(val) || cfg.xxx` 是防呆（解析失败/为 0 保持默认值），不会把越界值带进来；改为抛错会影响初始化流程。

9. **jsonFormatter.parseJSONToolCall 保留**
    被 `backend/__tests__/tools/jsonFormatter.test.ts` 引用（其余 3 个死导出已删除）。

10. **sanitizeHtml 对 srcset 内 data URL 含逗号的切分**
    data: URL 本身含逗号会被逗号拆分逻辑切分，但 base64 体无逗号且各段均通过白名单，重拼后 URL 语义不变；`data:image/svg+xml;utf8,<svg...>` 在 srcset 中极罕见且仅作属性值（浏览器不当作元素解析），无执行风险。

11. **sanitizeHtml 放行 video/audio 元素**
    现有放行语义，未扩大删除面（无 srcset 之外的属性注入面）。

12. **SubAgentMonitorPanel resolveClientId / postRoutedMessage 不做跨面板校验**
    只影响 monitor 自身 lifecycle 消息（monitorReady / getRunWindow 等）的响应回发，走面板直发路径而非 MessageRouter；monitor 伪造 `main-chat` 也只会把响应发回自己面板，无越权。非 lifecycle 消息全部经 `routeSubAgentMonitorMessage` 走已修复的入口。

13. **test/jest.setup.ts 空文件保留**
    已从 jest.backend.config.js 移除引用，文件无引用无害（删除可选）。

14. **toolBatchCheckpoint 测试的 fire-and-forget 绑定等待**
    已通过"轮询等待 after 最终绑定值"修复（`waitForBoundNode` 带 expectedId），不再是 flaky。

---

## 三、备注

- `backend/__tests__/tools/media/removeBackground.test.ts` 使用单工作区 mock + 相对路径（工作区外护栏修复后行为收紧为默认 deny）。
