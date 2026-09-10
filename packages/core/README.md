# 独立平台核心：首个存储阶段

当前完成 P1 的存储基础、可运行的 Node CLI，以及宿主独立的任务/工具循环、身份权限、审批和异步询问核心。模型传输适配、真实本地工具、Electron、Web UI 和消息平台仍在接入；任务循环当前已通过注入模型接口的集成测试。本阶段没有切换旧扩展的默认存储，也没有迁移真实用户数据。

## 运行

在仓库根目录使用 Node.js 22.15 或更高版本安装依赖并构建。当前实测环境为 Windows x64、Node 22.18.0、better-sqlite3 13.0.3（SQLite 3.53.4）。该版本包内自带 Windows、Linux 和 macOS 的主要架构预编译模块；其他系统与 Electron 安装包中的实际加载仍待验证。

```powershell
npm ci
npm run build:platform
npm run platform -- --help
npm run platform -- --data .tmp/platform-demo create demo "独立核心演示"
npm run platform -- --data .tmp/platform-demo append demo --text "第一条消息"
npm run platform -- --data .tmp/platform-demo history demo --limit 50
npm run platform -- --data .tmp/platform-demo verify
```

`--data` 必须显式指定新数据目录。CLI 提供创建、追加、分页、分叉、导入、统计、校验和垃圾回收；它还没有 HTTP 监听、账号登录或模型调用功能。

## 模块与存储

- `packages/contracts` 定义宿主无关的会话、消息、分页、快照和迁移结果类型。
- `PlatformStorage` 将异步请求交给专用 worker，SQLite、正文编码和压缩在 worker 内执行。队列最多保留 64 个请求，超出后明确返回 `STORAGE_BUSY`。
- SQLite schema v3 使用 WAL、`synchronous=FULL`、事务、准备语句缓存和版本检查，旧 schema v1/v2 自动升级并保留原历史。每个数据库只允许一个存储服务持有，多个客户端通过该服务访问。
- 消息正文采用 MessagePack，长文本和规范 Base64 附件改为内容对象引用；读取时恢复原有逻辑内容。签名、空白、换行、未知字段、特殊属性名与 UTF-16 码元保持无损。
- 内容按 SHA-256 去重，拆成 256 KiB 的独立块，按压缩收益选择 Zstandard level 3。小块保存在 SQLite，大且难压缩的对象块使用不可变外部文件。阈值是当前工程起点，尚未经过多种真实工作负载调优。
- 历史通过共享序列段和范围索引分页。分叉、快照复用前缀，追加与替换不会修改其他历史引用的正文；写入可传 `expectedRevision` 拒绝陈旧修改。
- `readConversationState` 与 `commitConversation` 提供跨历史、元数据、记录、快照和任务创建的一致性边界；运行期间的结构变更受到数据库互斥校验，元数据独立变更使用内容 token 检测冲突。
- `verify` 检查 SQLite、引用关系、历史连续性与内容校验值。`gc` 回收不可达内容，SQLite 空闲页会复用，但不承诺立即缩小数据库文件。

数据库和 `objects` 目录共同组成完整数据。不能仅复制 `platform.sqlite` 作为备份，也不能在运行中手动清理 WAL。在线备份、断电恢复验证和安装包验收仍是后续工作；当前请关闭服务后复制整个目录。

现有 `ConversationManager` 通过 `backend/modules/conversation/SqliteStorageAdapter.ts` 完成创建、追加、快照和子代理记录接入，真实运行测试无需 VS Code mock。这个适配器用于验证现有语义；新界面应直接使用分页接口。旧管理器仍存在全量历史操作，旧分支图、Diff 和用量服务也尚未全部改用新存储。

## 旧数据导入

关闭写入旧数据的应用后，将旧数据根目录或 `conversations` 目录作为来源。来源与新目录必须分开，不能互相嵌套。

```powershell
npm run platform -- --data .tmp/import-preview import-legacy "D:\OldGrayCodeData"
```

迁移器支持带元数据的旧 JSON 数组，以及 `history.index.json` 管理的 NDJSON 段。分段导入以索引中的已提交条数为准。缺少必要元数据、正文损坏或目标 ID 冲突都会报告错误；不会假造元数据或覆盖已有会话。

导入以最多 128 条消息或约 4 MiB 为一批，记录源身份、内容指纹和进度；未完成的会话对正常查询隐藏。同一来源可以在中断后继续，完成后重复导入会跳过。解析元数据、读取消息和导入结束均核对内容哈希，发现源变化后保留暂存状态并报告错误。源变化后的自动合并和迁移冲突处理界面尚未实现，需要保留来源并使用新的预览目录重试。

分支图、旧快照、Diff、检查点、用量、设置和其他附属文件还没有完成各自的语义迁移。它们会出现在 `pendingArtifacts`，有剩余产物或错误时 `readyForCutover=false`，CLI 退出码为 2。该字段为 true 只表示所选目录内的导入检查通过，不会自动切换旧应用。

## 已执行的验证

任务核心由 `PlatformRuntime` 消费模型输出，并按固定工具目录执行经过参数验证和账号授权的调用。调用方必须先验证真实账号，再提供 actor ID；外部请求不能提交 owner 标志。模型提供方通过 `ModelProvider` 注入，客户端订阅通知，客户端断线不自动取消任务。

`ask_user` 只用于可继续工作的普通问题。默认等候三分钟，反馈在工具批次完整结算后作为带来源的用户内容追加，避免插入无配对工具结果。调用 `answerQuestion` 和审批/取消接口都会重新检查当前账号。外部界面和 Bot 仍需遵守相同身份边界。

```powershell
npm run test:platform
npm run typecheck:all
npm run typecheck:platform
npm run benchmark:platform
```

当前 37 个平台测试通过，覆盖应用组合、设置事务、真实模型协议适配、Discord 身份绑定与原界面协议等新增路径。相关原前端回归 29 个、模型格式与渠道回归 48 个通过。独立 Electron 已使用本地 HTTP 测试模型完成原输入区、编辑器、原生终端、异步问答、跨入口审批结果同步、HTML 预览、20 个设置分类、系统字体和跨分类草稿保存验证；实测枚举 337 个 Windows 字体。首个存储阶段另通过 71 个现有会话回归用例。没有调用真实模型账号或登录 Bot，也没有本次远程 CI 结果。

桌面开发入口与当前迁移边界见 [桌面说明](../../apps/desktop/README.md)。现有提示词与上下文、工具/MCP 和完整附属数据迁移仍在继续，不能把界面已显示的全部功能视为运行验收完成。

首次合成基准与限制见 [BENCHMARK.md](BENCHMARK.md)。测试覆盖持久化重开、内容损坏、版本冲突、事务回滚、分叉/快照共享、回收、导入恢复、源文件保护和现有管理器集成；尚未覆盖操作系统断电、真实历史全集、跨设备运行或 Electron 安装包。
