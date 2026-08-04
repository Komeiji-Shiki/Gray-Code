# .graycode/research/ 文档索引

> 更新日期：2026-08-04（TREE 阶段收尾）。本目录是 GrayCode 项目所有研究报告、修复报告与拆分报告的归档区。

## 一、规划与研究

| 文档 | 内容 |
|---|---|
| `branch-tree-phases-research.md` | 树状分支第五~八阶段实施路径研究报告（现状盘点/实施顺序/设计决策/语义清单/模块划分/风险/测试） |
| `bcp-phase-research.md` | **第七阶段 BCP-02~08 实施研究**（字段预留核对/绑定路径/切换编排/安全闸/引用计数/测试矩阵 + 2 个待拍板决策） |
| `checkpoint-backend-review.md` | checkpoint 后端复审报告（CP-DEL-1/CP-IDX-1 等高危 + 中低危清单） |
| `conversation-history-performance-review.md` | 对话历史性能改造复审（用量索引并发高危 + 存储一致性中危） |
| `checkpoint-frontend-review.md` | 前端与 Webview 复审（配置丢失/错误语义/长任务超时等） |

## 二、功能实现报告（TREE 阶段）

| 文档 | 内容 |
|---|---|
| `tree01-02-reroll.md` | reroll 底座：chat.rerollStream 全链路 + 多候选 + 10 上限 |
| `tree03-05-edit-branch.md` | 编辑分支：chat.editBranchStream + appendHistoryToGraph 接线 |
| `tree04-06-switch.md` | 候选切换全链：rewriteHistoryFromBranchGraph + switchBranchCandidate 编排 |
| `tree07-10-frontend.md` | 前端：branchActions 切换重建 + BranchSwitcherBar ‹ 2/3 › |
| `tree08-usage-branches.md` | 用量含全部分支（读取时合并 + id 权威去重） |
| `tree09-branch-mgmt.md` | 软删/重命名/修剪 + 设置页清理区块 |
| `tree11-12-branch-tree.md` | 分支树面板 + 标签页快照 |
| `tree13-busy-guard.md` | 流式互斥 BRANCH_BUSY + 竞态测试 |
| `mig09-benchmarks.md` | 性能基准（三场景数据 + R8e 漂移恢复/深链补充） |

## 三、功能实现报告（早期）

| 文档 | 内容 |
|---|---|
| `agent-mailbox.md` | agent 间消息通信（agent.sendMessage + mailbox + 工具调用后注入） |
| `subagent-nested.md` | 子 agent 嵌套（深度上限 2、父过滤传播、级联清理） |
| `user-message-interrupt.md` | 用户消息插入（忙时投递主会话 inbox） |
| `branch-base-br0304-08.md` | 分支底座 BR-03/04/08（BranchGraph 纯函数 + sidecar 仓储 + 类型） |
| `branch-br01-02.md` | 稳定消息 ID BR-01/02（Content.id/parentId + 幂等迁移） |
| `branch-br05-09.md` | 分支接线 BR-05/06/07/09（BranchService/BranchHandlers/锁包装/导出建模） |
| `bcp01-nodeid.md` | BCP-01 messageNodeId 接线 |
| `bcp02-workspace-bind.md` | BCP-02 节点↔存档绑定（bindWorkspaceCheckpoint + 工具执行存档点接线） |
| `bcp03-05-switch-workspace.md` | BCP-03/04/05 切换双模式 + dirty 拦截 + 恢复失败不切分支 |
| `bcp06-refcount-cleanup.md` | BCP-06 引用计数清理（三重闸门 + purge/prune 联动） |
| `bcp07-08-verification.md` | BCP-07 增量链共享固化（决策 12）+ BCP-08 矩阵盘点 |
| `mig02-05.md` | 迁移批次 MIG-02~05（核实结论 + BranchMigration + integrityCheck） |

## 四、修复报告

| 文档 | 内容 |
|---|---|
| `background-agent-truncation-fix.md` | 后台子 agent 报告 4000 字符截断修复 |
| `fix-audit-remediation-batch1.md` | 审计修复 F-01/02/03/05 核对 + 测试补齐 |
| `fix-checkpoint-security.md` | checkpoint 安全 B1（CP-DEL-1/CP-PATH-1/CP-IDX-1 等） |
| `fix-checkpoint-exclusion.md` | 排除与设置校验 B2（深合并/类型校验/大小写折叠） |
| `fix-checkpoint-builder-query.md` | 快照构建/查询收敛 B3 |
| `fix-usage-index.md` | 用量索引并发 B4（per-conversation 写队列） |
| `fix-history-storage.md` | 历史存储 B5（读一致性/浅扫描/删除复活） |
| `fix-frontend-settings.md` | 前端设置页 B6 |
| `fix-frontend-messages-webview.md` | 前端消息/Webview B7 |
| `fix-checkpoint-restore-perf.md` | 恢复性能 B8（并行哈希/预览免锁） |
| `fix-restore-order-progress.md` | 恢复顺序与进度 T2（先拷后删） |
| `fix-frontend-leftovers.md` | 前端遗留 T3 |
| `fix-notifications-launch.md` | 通知/launch 核对 T4 |
| `fix-agentinbox-replay.md` | agentInbox 历史重放修复 |
| `fix-errorcodes-retry.md` | 错误码白名单与重试路径修复 |
| `fix-frontend-ux-round2.md` | 前端 UX 9 项修复 |
| `fix-usage-storage-round2.md` | 用量/存储复审修复 |
| `fix-r4-security.md` | R4 安全修复（嵌套权限逃逸/空集拒绝） |
| `fix-r6a-reroll-stream.md` | reroll/editBranch 流式链路修复（取消接线/队列/检查点/错误透出） |
| `fix-g1-mailbox.md` | FIX-G1：agentInbox 当轮保留 + drain epoch + mailbox 清理 + R5b 四项 |
| `fix-g2-restore-rules.md` | FIX-G2：恢复侧 profilePatterns/excluded 保护 + R7b 复查与修复（前缀匹配） |
| `fix-g3-branch.md` | FIX-G3：branch 读取侧语义校验 + 锁序 + 删除串行化 + appendHistoryToGraph |
| `fix-g4-frontend.md` | FIX-G4：前端 Map 清理/U1 回显/v-memo 等 6 项 |
| `fix-r7a-mailbox-consistency.md` | R7a-FIX：回合边界谓词统一 + 早启动不 drain + epoch 清理 + 子代理剥离 |
| `fix-r8-softdelete-usage.md` | R8-FIX：级联软删/恢复 + switch 链校验 + 用量去重/估算修正 |
| `fix-r8a-switch-idempotency.md` | R8a-FIX：FR id 复用 + 回滚完整性 + 尾部一致性检测 |

## 五、拆分报告

| 文档 | 内容 |
|---|---|
| `split-checkpoint-manager.md` | CheckpointManager 2413→1687 行拆分 |
| `split-checkpoint-settings.md` | CheckpointSettings.vue 3284→2263 行拆分（5 个 composable） |
| `split-settings.md` | SettingsManager 门面+14 服务 / settings types 11 主题文件拆分 |

## 六、重要备忘

| 文档 | 内容 |
|---|---|
| `PROJECT-STATE.md` | **项目状态与重要备忘（必须读）**：规则/进度/决策/待办/架构/坑 |

> 注意：各 fix-* 报告的"验证结果"仅代表该批次当时的状态；最终以 `npm test`（后端 138 套/1517）+ `npm --prefix frontend test`（22 文件/267）+ 双 typecheck 全绿为准。基准测试：`npx jest --config jest.backend.config.js --testMatch "**/*.benchmark.ts"`。
