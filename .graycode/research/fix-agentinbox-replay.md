# FIX-B：agentInbox 历史重放修复 — 修改摘要 / 验证结果

> 批次：FIX-B（agentInbox 历史重放）
> 依据：R2 复审问题 5.1（高）/ 5.2（中）/ 5.3（低）
> 范围：仅 `ToolExecutionService.ts`（注入点）、`conversation/helpers.ts`（cleanFunctionResponseForAPI）、测试文件；未触碰 CHANGELOG / 规划文档 / UsageIndexStore / storage / ConversationManager / frontend / webview / checkpoint / settings。

## 一、问题与修复方案

### 5.1（高）agentInbox 随 functionResponse 落入历史并被重放

**根因**：`injectInboxMessages` 把 `agentInbox` 写进 `functionResponse.response`，该 parts 经 addContent/settleFunctionResponses 原样落入历史；`cleanFunctionResponseForAPI` 只剥离 diffContentId/diffId/diffs/pendingDiffId/toolId/terminalId/multiRoot/command/cwd/shell/channelName/modelId/steps，不剥离 agentInbox → 后续每轮请求都把 agent 消息重放给模型（drain 一次性语义被破坏、prompt 持续膨胀）。

**修复（采用推荐方案，最稳）**：在 `backend/modules/conversation/helpers.ts` 的 `cleanFunctionResponseForAPI` 中，**顶层与 `data` 子对象一并剥离 `agentInbox`**。

- 该函数是唯一收敛点：`cleanContentForAPI`（TokenCountService 计费/计数、历史发送路径）与 `ConversationManager`（API 请求历史路径 L2005）都经它清理 functionResponse；
- 剥离后：当轮注入照常（模型在当轮工具结果里仍可见 agentInbox，行为不变），历史发送时 agentInbox 被剔除 → 信箱消息不会被重放；
- 前端 toolResult 展示不受影响：frontend 无任何 `agentInbox` 字段依赖（已全仓搜索确认），`toolResult.result` 注入保留。

### 5.2（中）drain 先于注入目标校验

**修复**：`injectInboxMessages` 改为**先校验注入目标再 drain**——`responseParts` 末尾必须是 `functionResponse` part，否则直接返回、不消费 inbox（消息保留到下一次工具调用，不丢失）。

- 现状所有真实路径（含多模态、参数错误/策略拒绝）都会先 push functionResponse part，故为防御性保护；
- 修复前若未来出现"无注入目标"路径，消息会被 drain 后丢弃；修复后不会发生。

### 5.3（低）注释与实现不一致

**修复（对齐实现，与设计文档意图一致）**：模型可见路径此前只注入 `functionResponse.response` 顶层；现按注释与 `.graycode/research/agent-mailbox.md` 设计意图，**顶层 + `data` 子对象同时注入**（覆盖 formatter 的 JSON / 文本两条序列化路径）。注入采用非变异方式（`data` 重建新对象），避免污染工具原始响应对象；`toolResult.result` 前端注入维持原位注入（其对象本就是深拷贝，安全）。

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/helpers.ts` | `cleanFunctionResponseForAPI`：顶层与 `data` 子对象 destructuring 中新增剥离 `agentInbox`；更新 JSDoc（标注 A-COMM 瞬态消息、禁止历史重放） |
| `backend/modules/api/chat/services/ToolExecutionService.ts` | `injectInboxMessages`：①先校验注入目标（末 part 为 functionResponse）再 drain（5.2）；②模型可见路径顶层 + `data` 子对象同时注入（5.3 对齐注释）；③toolResult.result 注入保留；④JSDoc 同步更新 |
| `backend/__tests__/tools/agentSendMessage.test.ts` | 新增「历史重放防护（FIX-B）」describe：当轮注入顶层 + data 均可见；cleanFunctionResponseForAPI 剥离顶层与 data 的 agentInbox（防重放）且其余字段保留；无注入目标时不 drain（5.2，含正向路径断言） |
| `backend/__tests__/conversation/helpers.test.ts` | **新增**：cleanFunctionResponseForAPI 剥离 agentInbox（顶层/data/同时）+ 既有内部字段剥离不回归 + 保留字段（killed/duration/output/message/results）+ 非对象输入；cleanContentForAPI functionResponse part 剥离 agentInbox 与内部字段 |
| `backend/tools/subagents/agentMailbox.ts` | 无需改动（采用"先校验后 drain"策略，drainMessages 语义不变） |

未触碰：`CHANGELOG.md`、规划文档、UsageIndexStore / storage / ConversationManager（其他批次）、frontend / webview / checkpoint / settings。

## 三、验证结果

- 定向测试：`agentSendMessage.test.ts`（19 用例，原 16 + 新 3）+ `agentMailbox.test.ts`（18）+ `helpers.test.ts`（新增 8）＝ **45 通过**；
- 回归测试：`backend/__tests__/tools`（32 套）+ `backend/__tests__/conversation`（21 套）+ `backend/__tests__/channel`（12 套）＝ **65 套 / 735 用例全部通过**（含 formatter 系列、subagents、ConversationManager 系列、metadataCorruption 等）；
- 类型检查：`npx tsc -p ./ --noEmit` → **0 错误**；
- 行为确认：当轮 `functionResponse.response.agentInbox`（顶层 + data）仍可见 → 模型当轮感知不变；`cleanFunctionResponseForAPI` 后 agentInbox 消失 → 历史不再重放；前端不依赖 agentInbox 字段，展示不受影响。

## 四、遗留说明

- 历史中已持久化的旧 functionResponse 仍含 agentInbox（此前批次写入的数据），但因发送路径统一经 `cleanFunctionResponseForAPI` 剥离，重放问题对存量数据同样生效修复；
- 5.2 校验为防御性保护：当前所有注入点调用前均已 push functionResponse part，无行为变化。
