# 独立平台记忆

记忆分两部分：数据目录 `memory/` 下的 Markdown 文件记忆，以及数据库里的导入资料库。两者共用同一个总开关，但读取方式不同——文件记忆用普通文件工具直接读写，导入资料库靠三个只读工具按需检索。

## 文件记忆

**目录布局。** 根目录由 `memoryDirectory(storageDirectory)`（`src/memory/files`）给出，设置页显示的路径、备份按范围列出的目录、工具判断归属都取自这一处，不再各自拼 `'/memory'`。`memoryRoots` 按会话返回当前可用的范围：

| 目录 | 什么时候使用 |
| --- | --- |
| `memory/global` | 主人账号的普通会话与伙伴会话 |
| `memory/projects/<目录名>-<sha256(工作区目录)前 12 位>` | 有工作区时追加，`memory:` 开头的临时工作区不追加 |
| `memory/bots/<discord\|qq>-[dm-]<频道编号>` | Bot 会话独占，私聊带 `dm-` 前缀 |
| `memory/characters/<根会话 ID>` | 角色故事会话独占，由 `platformMode === 'character'` 判定 |

Bot 与角色会话只返回自己的目录，不再叠加全局记忆；子代理按根会话判定范围，所以群聊子代理拿到的是频道目录。范围判断先看会话记录再决定，普通授权账号没有主人身份时返回空数组，模型拿不到任何记忆根。每个目录用一个 `MEMORY.md` 作索引（一行一条记忆），每条记忆单独一个带 frontmatter 的 Markdown 文件，宿主不解析 frontmatter，格式由提示词指引模型自己维护。

**`memory:` 临时工作区。** 没有工作区时，模型照样要能写记忆，但文件工具需要工作区才能解析相对路径。`prepareMemoryWorkspace` 在每个工具调用前运行：只处理读写类工具、只处理本次参数里的全部路径都落在同一个记忆根内的情况，然后建立 `{ id: 'memory:<目录名>', directory: 该记忆根 }` 作为本次调用的临时工作区。这个工作区不在设置里登记，归属判断统一走 `memoryWorkspaceId` 与 `ownsMemoryWorkspace`，差异列表、差异处理、预览打开与文件事务共用同一判断，不再各写一份比较逻辑。

**免审阅写入。** 记忆目录内的写入在 `WorkspaceDiffs` 里按 `memoryWrite` 走 `immediate` 应用，不受自动保存开关和差异审阅影响——记忆是模型按指引自己维护的文件，卡在审阅里等于记忆写不进去。工具卡片仍保留修改详情，可以事后打开看改了什么。

**索引快照随回合保存。** 索引放在历史之前，任何变化都会让整段对话的请求前缀失效，所以会话第一次组装提示时读一次 `readMemoryIndex`，结果随这一回合的动态上下文一起存进消息（`promptContextCache.memoryIndex = { roots, text }`）。后续回合只要记忆根目录列表没变就沿用快照，会话中改写记忆文件、重启应用都不重读；换会话、换工作区或 Bot 频道才重新捕获。子代理回合不保存动态上下文，每次运行开始时读取一次。单份索引超过 200 行或 25 KB 时保留上限内的完整行，末尾给出截断提示。

**备份按范围目录处理。** `memoryScopeDirectories` 列出数据目录里实际存在的范围目录（`memory/global`、`memory/projects/*`、`memory/bots/*`、`memory/characters/*`），`restorableDirectories` 把它们作为 `memories` 类别的目录单元交给选择性恢复界面，与技能目录一样按整目录“保留或替换”。选择性恢复搭建暂存副本时会带上当前的 `memory/` 目录，否则切换数据目录后记忆文件只会留在恢复前的副本里。

## 导入资料库

**三个只读工具。** `memory_topics` 逐层浏览授权范围、主题和摘要，用 `nextCursor` 续读当前层；`memory_search` 结合关键词与语义匹配，支持主题、类别、时间筛选，结果受 `tokenBudget` 限制；`memory_read` 按 `ids` 读取正文，`includeSources` 附带来源，长文用 `page` 分段、`nextOffset` 续读同一版本。三者都在 `longMemoryTools` 里注册，效果声明为 `workspace_read`。

能检索到的范围来自 `conversationMemoryScopes`：只认 `MEMORY_IMPORT_POLICY_NAMESPACE` 里用户显式启用的 `library` 范围，且必须属于当前账号、`realm` 为 `real`。资料库不再每轮自动召回，只有当总开关打开、本轮工具清单里有 `memory_search`、且确实有可用范围时，才在 MEMORY 段落尾部追加一次 `LONG_MEMORY_GUIDANCE`，把三个工具的用法讲清楚。资料库不属于当前会话授权范围时，`PlatformLongMemory.access` 直接报错，不静默退化成空结果。

**后台摘要与向量任务。** `MemoryBackground` 由持久任务驱动，队列空时不启动定时轮询。两类任务：

- `summarize`：按依赖的记录版本读取来源，用策略里选的渠道和模型写分层摘要；来源缺失或版本失效就让任务失败，不拿残缺资料凑摘要。摘要以新的 `summary` 记录写回，主题取 `job.topic`。
- `embed`：按每批 16 条记录、以记录版本为依赖入队；执行前重新核对版本，嵌入配置（地址、模型、维度、前缀）变了就要求按新模型重建索引，不混用旧向量。

两条路径都会在写入前重新确认账号权限和原任务范围仍然有效，任务记录保留 usage 与失败原因，界面上的任务列表读的就是这些。

**旧的抽取任务。** 自动抽取已经移除，但旧版本留下或被重试的 `extract` 任务仍会出现在待处理队列里。调度循环遇到 `extract` 直接转为已取消、不调用模型，避免这些任务永久挂起，也避免它们把队列堵在同一个范围上。

旧数据库格式的原格式记忆、导入资料库记录与文件记忆并存：格式和记录都不迁移、不删除，只是新记忆统一按文件指引保存。
