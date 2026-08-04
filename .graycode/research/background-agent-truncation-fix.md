# 后台子 agent 完成消息被截断 — Bug 根因分析与修复

> 日期：2026-08-04
> 项目：GrayCode（根目录 `a:\api\Gray-Code-main`）
> 状态：已修复并验证

## 一、Bug 现象（用户实测）

调用 `subagents` 工具并传 `background=true` 启动后台子 agent，任务完成后送达主模型的消息被截断，末尾形如：

```
[Truncated 24558 more characters. Open Monitor to view the full transcript.]
```

前台（不传 `background`）子 agent 的回复完整。主模型读不到后台子 agent 的完整输出（本次会话已三次中招：研究/审查报告全部被腰斩）。

## 二、根因分析

### 2.1 数据链路（后台子 agent 结果 → 主模型）

1. **后端执行**：`backend/tools/subagents/subagents.ts` `executeSubAgent` 后台分支（L387-435）注册任务后不 `await`，settle 时调用
   `TaskManager.unregisterTask(taskId, status, { runId, agentName, response: result.response, steps, ... })`
   —— `result.response` 是**完整**最终回复（`executor.ts` 中 `lastResponse = textContent`，无截断）。
2. **IPC 转发**：`backend/tools/taskManager.ts` 发出 `complete` 事件 → `webview/ChatViewProvider.ts` `handleTaskEvent`（L443-448）`postMessage({ type: 'taskEvent', data: event })` 原样转发给前端 —— **无截断**。
3. **前端存储**：`frontend/src/stores/backgroundTaskStore.ts` `applyCompletionEvent` 把 `data.response` 完整写入任务记录 —— **无截断**。
4. **回执构建（截断点）**：`frontend/src/stores/backgroundTasks/reportBuilder.ts` `buildSubAgentSection`：
   ```ts
   const SUBAGENT_RESPONSE_MAX_LENGTH = 4000
   ...
   if (response.length > SUBAGENT_RESPONSE_MAX_LENGTH) {
     lines.push(`${response.slice(0, SUBAGENT_RESPONSE_MAX_LENGTH)}…`)
     lines.push(`[Truncated ${response.length - SUBAGENT_RESPONSE_MAX_LENGTH} more characters. Open Monitor to view the full transcript.]`)
   }
   ```
   —— **这里就是截断点**。用户看到的 `[Truncated 24558 ...]` 正是此行生成（4000 + 24558 ≈ 28.5K 字符的报告被腰斩）。
5. **注入主模型**：`backgroundTaskStore.flushReports()` → `chatStore.sendMessage(report)` → `frontend/src/stores/chat/messageActions.ts` `sendMessage` 把回执作为**普通 user 消息**完整进入对话历史并经 `chatStream` 发给模型 —— 无截断。

### 2.2 为什么前台完整、后台被截断

- **前台**：`subagents.ts` 前台分支把 `result.response` 放进 functionResponse 的 `data.response`，`cleanFunctionResponseForAPI`（`backend/modules/conversation/helpers.ts` L306）**只过滤内部字段、不截断**，模型读到完整回复。
- **后台**：工具调用立即返回 taskId stub，主模型**唯一**拿到结果的通道就是这条完成回执；而回执构建处硬编码截断到 4000 字符。
- 补充排查（均排除）：
  - 后端 `unregisterTask` 载荷：完整，无截断；
  - `webview/ChatViewProvider.ts` taskEvent 转发：原样 postMessage，无载荷上限；
  - `frontend/src/utils/vscode.ts` `sendToExtension`：JSON 往返序列化，无长度截断；
  - `backend/modules/api` chat 模块：用户消息无长度硬上限；
  - `runEventBus.ts` 的 `MANIFEST_PREVIEW_MAX_LENGTH`（160）/ `DEFAULT_CONTENT_WINDOW_LIMIT`（20 条）只影响 Monitor 面板的预览与窗口渲染，不影响回执正文。

### 2.3 为什么「去 Monitor 看完整 transcript」对主模型无效

Monitor（`SubAgentMonitorPanel.ts`）是人类可交互 UI；主模型没有访问 Monitor 的路径，截断提示等于把产出静默丢弃。修复方向应是让**回执本身携带完整结果**，而不是把主模型引向人类 UI。

## 三、修复内容

**方案**：删除 `reportBuilder.ts` 中 4000 字符截断，完整内联后台子 agent 结果正文——与前台 functionResponse 载荷完全同规格。

**为何不需要额外 IPC 载荷防护（不引入落盘/分段等过度设计）**：

1. 完整结果本来就经 `postMessage` 从后端转发给前端 Monitor（现状无截断、可正常展示数万字 transcript），IPC 通道已被证明可承载该载荷；
2. 回执经 `chatStream` 走与普通用户消息完全相同的发送路径，后端 chat 模块对用户消息无长度上限；
3. 前台子 agent 的完整回复（同等量级，用户实测可达数万字）已经能正常进入对话历史与 API 请求，后台回执与之同规格，不存在新增风险。

### 修改文件

| 文件 | 修改 |
| --- | --- |
| `frontend/src/stores/backgroundTasks/reportBuilder.ts` | ① 删除 `SUBAGENT_RESPONSE_MAX_LENGTH = 4000` 常量及其注释（L53-61）；② `buildSubAgentSection` 中截断分支（`slice(0, 4000)` + `[Truncated ...]` 提示）替换为完整内联 `lines.push(response)`，同步更新「修改原因/方式/目的」注释（L147-161） |
| `test/unit/frontend/stores/reportBuilder.test.ts` | 新增回归用例：12000 字符超长报告完整出现在回执中，且不出现 `[Truncated` / `Open Monitor` |
| `CHANGELOG.md` | `[Unreleased]` 新增 `### Fixed` 条目，记录根因与修复 |

**未修改**（确认与截断无关，保持不动）：`backend/tools/subagents/*`、`webview/*`、`frontend/src/stores/backgroundTaskStore.ts`、`chatStore`/`messageActions`、Monitor 面板相关代码。

## 四、验证结果

1. **单元测试**：`npx jest --config jest.backend.config.js test/unit/frontend/stores/reportBuilder.test.ts` → **12/12 通过**（含新增回归用例「超长结果不再截断」）。
2. **后端子 agent 测试**：`npx jest --config jest.backend.config.js backend/__tests__/tools/subagentsTool.test.ts` → **9/9 通过**（后台注册/注销载荷完整等行为不变）。
3. **类型/语法检查**：`npx tsc --noEmit --strict --skipLibCheck --target es2020 --module esnext --moduleResolution bundler frontend/src/stores/backgroundTasks/reportBuilder.ts` → **EXIT 0**；ts-jest 在测试运行中亦完成类型检查。
4. **行为核对**：搜索确认无其他代码引用 `SUBAGENT_RESPONSE_MAX_LENGTH`；测试中仅新增用例断言 `[Truncated`/`Open Monitor` 不出现。

修复后后台子 agent 完成回执将携带完整结果正文，主模型可读到与前台一致的完整研究/审查报告，不再出现 `[Truncated N more characters...]`。
