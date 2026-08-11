# 已知问题与设计决定清单

> 来源：2026-08-04 多轮全仓扫描（38+ 子代理，约 140 项发现）后仍存留的问题，
> 以及有意保留的设计决定（供后续维护者参考，避免误改）。
>
> 清单状态：
> - 2026-08-04 初始扫描建档
> - 2026-08-10 首次按当前源码复核
> - 2026-08-11 复核确认：「未修复问题」4 项均已解决/收敛（详见第一节），
>   现无未决问题；本文件仅保留已解决记录（供追溯）与有意保留的设计决定（勿误改）。

---

## 一、已解决/已收敛（2026-08-11 复核确认）

### 1. MarkdownRenderer 流式重复全量解析 — 已解决
- **原位置**：`frontend/src/components/common/MarkdownRenderer.vue`
- **原问题**：流式渲染对每条消息的完整累积内容反复 markdown-it 解析 + sanitize DOM 遍历（约每 120-180ms 一次），长消息总成本接近 O(n²)
- **解决方式**（多层缓解，非 MarkdownRenderer 内部增量渲染，而是上游架构演进 + 渲染层限频）：
  - 上游「渐进 markdown 提升」：`smoothStreamManager.findPromoteCut`（fence/表格/html block/空行安全边界状态机 + markdown-it token map 校准）只把「已定型完整段落前缀」append-only 累积进渐进渲染器（`MessageItem.handleTailPromote` / `MessageRenderBlock.handleThoughtPromote` 维护的 tailRendered/thoughtRendered），未定型尾巴留在 CharFlow 逐字输出、不进入 markdown 渲染；段落切换/终结时清空累积，由 renderBlocks 稳定块完整接管
  - 渲染层：流式节流（leading + trailing + max-wait，120ms/180ms）、已完成消息 LRU 缓存（128 条，含工作区文件存在性签名）、内容快照跳过无变化重渲染
- **结论**：不再存在对完整累积内容的重复全量解析（渲染输入被限制为小得多的已定型前缀且周期性归零）；MarkdownRenderer 内部再做增量渲染不再必要

### 2. activationEvents 使用 onStartupFinished — 已解决
- **原位置**：`package.json:19-21`
- **解决方式**：已移除 `activationEvents` 字段，改由 VS Code 对 `contributes.commands/views` 的默认按需激活；`extension.ts` 的 `activate` 已收敛为轻量初始化（Logger / productMetadata / ChatViewProvider 注册 / 基础命令），不再有每次启动触发的后端初始化与历史迁移
- **结论**：未使用聊天面板的用户不再承担扩展启动开销

### 3. jest / vitest 前端测试归属 — 已解决
- **原位置**：`test/unit/`（jest）与 `frontend/src/__tests__/`（vitest）
- **解决方式**：`test/unit` 整体归位删除（tools/settings → `backend/__tests__`，前端用例并入 frontend vitest 域）；`jest.backend.config.js` roots 仅扫描 `backend/__tests__` 与 `test/benchmark`；前端唯一测试域为 `frontend/src/__tests__/`（vitest）
- **结论**：测试归属清晰，本地命令分工明确（`npm test` 后端 jest / `npm run test:frontend` vitest / `npm run ci` 全量门禁）

### 4. design / plan pathUtils 收敛 — 已解决
- **原位置**：`backend/tools/design/pathUtils.ts`、`backend/tools/plan/pathUtils.ts`
- **解决方式**：抽出更通用的共享模块 `backend/tools/shared/pathPolicy.ts`（`isScopedPathAllowedWithMultiRoot` + scope 文案 + 父目录创建），design/plan/progress 三处 pathUtils 均瘦身为薄封装委托同一实现；design 保留 `ensureParentDirWithFs`（fs.promises.mkdir）与 `ensureParentDir`（vscode.workspace.fs）的差异为有意为之（远程/虚拟工作区行为与测试 mock 依赖，注释有说明）
- **结论**：收敛完成，纯重构零风险目标达成

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

13. **toolBatchCheckpoint 测试的 fire-and-forget 绑定等待**
    已通过"轮询等待 after 最终绑定值"修复（`waitForBoundNode` 带 expectedId），不再是 flaky。

15. **后台 SubAgent 完成时双通道通知（Monitor 协议 + 任务条/回执）**
    后台 subagent（显式 `background=true`，或前台 detach 转后台）完成时，两处 UI 各收一份通知：
    Monitor（runEventBus 的 `subagentMonitor.event` / `manifest` 协议）与任务条/回执（TaskManager
    的 `taskEvent` 协议）。这是两系统分工的预期结果，非缺陷：runEventBus 是运行级/内容级协议
    （状态机 + transcript + 持久化），TaskManager 是任务级 UI/回执契约（无持久化），二者互不感知，
    由 `detachedTaskBridge` 订阅 runEventBus 终态事件后手动同步注销 TaskManager 任务
    （分工边界详见 `backend/tools/taskManager.ts` 头注释）。

---

## 三、备注

- `backend/__tests__/tools/media/removeBackground.test.ts` 使用单工作区 mock + 相对路径（工作区外护栏修复后行为收紧为默认 deny）。
- 原「未修复问题」清单中的 `test/jest.setup.ts` 空文件（曾列为设计决定）已随测试归位一并删除，相关说明不再保留。
