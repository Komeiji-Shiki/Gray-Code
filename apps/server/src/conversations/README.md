# 对话变更与任务衔接

`ConversationService` 是独立宿主的历史变更入口。原界面 RPC 和新 API 使用同一服务。主历史继续由 SQLite 历史段保存，普通生成只追加消息；分支记录在读取时用当前主历史更新活跃路径，在结构变更时提交，避免每个流式增量都重写分支图。

## 一致性合同

1. `readConversationState` 在同一次 worker 请求中读取元数据、内容版本和相关记录。元数据 token 是内容哈希，能检测不改变历史版本的并发重命名等操作。
2. `commitConversation` 在一个 SQLite 事务中校验版本与活跃任务，并提交历史、元数据、记录、恢复快照及可选的新任务。任何一步失败都会整体回滚；相同 request key 直接返回原任务。
3. 删除先校验稳定消息 ID，再取消并等待已有任务；取消结束后重新读取并校验。分支切换直接拒绝活跃任务。存储层再次检查，防止检查与提交之间新任务进入。
4. 编辑/重新生成事务成功后才开始模型请求。模型失败后的错误重试从已提交历史继续，不再次执行编辑或分支事务，也不自动重放旧工具调用。
5. 原候选保存完整消息组，工具结果的独立消息 ID、签名、附件、时间和每回合动态上下文保留；图节点只保存拓扑和必要元数据，界面收到摘要投影。切换时从消息组重建当前路径，重设展示索引和父链。
6. 修改前自动保存可恢复的历史快照，采用现有共享历史段；快照和变更一起提交。它不包含工作区文件。`chat-and-workspace` 在文件检查点恢复接入前明确报错，不能静默降级为只切聊天。

原图运算复用 `backend/modules/conversation/branch/BranchGraph.ts`，原删除与总结覆盖区恢复复用 `TranscriptMutation.ts`。原有每父节点最多 10 个候选、根用户消息编辑沿用原 ID、非根编辑创建新候选、原地保存保留后续内容等语义保持一致。

## 当前接口

原界面已接入 `retryStream`、`chat.rerollStream`、`chat.editBranchStream`、两种消息删除，以及分支读取、切换、软删除、恢复和重命名。新 API 提供 `runs.continue`、`conversations.branches`、`conversations.branch.switch`、`conversations.messages.delete`、`conversations.snapshots.list/restore`。继续任务与快照恢复要求调用方提交读取到的历史版本。

原生文件检查点、跨对话导出分支、过期分支清理界面和完整旧分支文件迁移仍由后续任务接入。不要直接实例化旧文件仓库往新数据目录写 `branches.json`，也不要启用原全局 BranchService 去异步修改同一历史。

验证重点见 `packages/core/tests/conversationTransaction.test.ts` 和 `conversationFlows.test.ts`：原子回滚、旧元数据拒写、运行互斥、重复请求、重开恢复、分支候选与工具结果、消息编辑、取消和快照恢复。桌面脚本额外点击原重新生成确认框及候选切换按钮，检查实际历史和界面。
