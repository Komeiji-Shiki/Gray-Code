# Change Log (GrayCode Desktop)

本文件记录 GrayCode Desktop（Electron 独立桌面版）的变更。
桌面版基于 GrayCode VS Code 插件（backend/webview 代码）复用构建；
插件本体（backend / frontend 公共部分 / webview）的变更见根目录 `CHANGELOG.md`。

This file tracks changes to the GrayCode Desktop (standalone Electron edition).
Changes to the shared plugin codebase (backend / webview / shared frontend)
are tracked in the root `CHANGELOG.md`.

## [Unreleased]
### Merged（1.7.12dev：同步上游 308c79d4——渠道配置启动预加载 + 发布前修复批次：checkpoint 分支隔离/config 串行队列/MCP 生命周期/SSE 流式下载/memory 位图缓存）
  - 合入上游发布前修复批次；不采纳上游 VS Code Marketplace 上架文档（桌面版非插件，README 保持本地版本）

### Merged（1.7.12dev：同步上游 main 至 0107c597——模块化摊平 1-9 批 + Bug Hunt 五轮 150+ 修复 + MCP/memory/prompt/子代理/输入框等修复）
  - 合入上游 40+ commits：模块化摊平重构（registry 死系统删除、ChatFlowService/ConversationManager/CheckpointManager/ToolExecutionService 等大文件拆分至 flow/、manager/、tool-execution/、subagents/executor|eventBus、tools/shared/ 等子目录，后端依赖方向清零）；
  - 修复吸收：fileWriteLock 复合身份键 + acquire 参数化超时、MCP stdio 生命周期/串行队列/原子写、memory 迁移降级与 1000 上限、prompt 动态上下文差分加固、子代理并行段收尾 30s 兜底、输入框残留双机制、流式 Markdown 表格渐进渲染、恢复默认模板 {{$MEMORY}} 占位符等；
  - 桌面版独有功能全量保留（远程控制 V7.2、桌面背景图、agentInbox、多工作区、安全加固）；不采纳上游 nightly 自动更新机制与 fast-tavern 子项目；版本 1.7.12dev

### Added（1.7.11dev：桌面端自定义背景图——外观设置新增本地图片窗口背景 + 不透明度调节）
  - **外观设置新增「桌面背景图」**：选择本地图片（PNG/JPG/JPEG/GIF/WebP/BMP，上限 10MB）作为应用窗口背景，cover 铺满整窗；不透明度滑块（0-100，默认 30）实时作用于图片本身，文字与界面不受影响；设置页提供 16:9 预览框、路径回显与一键移除；设置搜索新增「背景图/壁纸/透明度」锚点；
  - **数据流**：持久化仅存路径（ui.appearance.wallpaperPath/wallpaperOpacity），图片内容经新增 IPC 处理器（pickWallpaper 原生对话框选图 + 校验读取；getWallpaperImage 按已存路径重读）以 data URL 交给渲染层（webview CSP img-src 已含 data:）；文件丢失/失效静默回退纯色背景；SVG 刻意排除（防脚本面）；
  - **渲染**：App.vue 新增 .app-wallpaper 图层（fixed 整窗 + z-index:-1 + isolation 层叠上下文），pointer-events:none 不拦截交互；选择/拖动滑块即时应用到窗口背景（保存前可见效果），保存时随外观设置持久化；聊天区四个全幅不透明容器（消息列表/输入区/欢迎页/页签栏）改为透明，背景图持续可见（消息行/输入框/页签自身背景保留）；远控端不涉及；
  - 测试：WallpaperHandlers 单元测试（选图/白名单/大小上限/丢失回退/取消）+ 默认值断言；三语言文案齐全。

### Fixed：远程控制 V7.2——图标零面积路径修复（plus/close/check/chevronDown/folderUp）+ 渠道表单死控件 + 思考关闭开关 + 分页/竞态加固
  - **修复图标渲染缺失（用户报告：关闭对话 ✕、新建对话 ＋、关闭设置 ✕ 及其他图标不可见）**：根因是 ICONS 注册表中 plus/close（及 check/chevronDown/folderUp）使用零面积线段路径（如 M12 5v14M5 12h14），而全部 SVG 仅设 fill="currentColor" 无 stroke——fill 对零面积路径不产生任何像素，图标在所有配色模式下都不可见（真实 Chromium 像素级验证）。已全部改为 Material 实心闭合路径（plus/close 同时修正 remoteControlUi.ts 内 5 处静态内联 SVG），与其余 53 个填充型图标一致；新增回归断言（静态 ✕/＋ 与动态 tab-close/tab-add 路径必须含闭合 z）。
  - **浅色主题变量补齐**：@media (prefers-color-scheme: light) 的 :root 块此前缺失 --vscode-icon-foreground、--vscode-toolbar-hoverBackground、--vscode-toolbar-activeBackground、--vscode-focusBorder、--vscode-editor-selectionBackground、--vscode-scrollbarSlider-*、--vscode-button-foreground、--vscode-inputValidation-warningForeground、--vscode-tab-activeBorderTop 共 10 个变量（浅色下回退深色值导致图标/交互色与白色背景混淆）；同时补齐从未定义的 --vscode-textCodeBlock-background/--vscode-editorHoverWidget-background（此前仅靠 fallback）。
  - **修复渠道内联表单 13 处「开关+数值」死控件**：chInlineOpt 生成的 temperature/max_tokens/maxOutputTokens/top_p/top_k/frequencyPenalty/presencePenalty/maxImages 控件此前无任何 change 监听与保存回调（chInlineOptRead 从未被调用），用户修改后静默丢弃。现改为即时保存：开关写 optionsEnabled.X（显式 true/false），数值写 options.X（新增 saveInlineOpt）。
  - **修复思考配置/推理分组「关闭」开关无效**：关闭时此前 delete optionsEnabled.thinkingConfig/thinking/reasoning 提交，服务端 deepMerge 对缺失键保留原值 → 关闭是 no-op。改为显式写 false（与桌面端 ChannelSettings 语义一致），表单重渲染不再弹回开启态。
  - **修复 checkpoint 排除「最大文件大小」单位错误**：字段标签为 MiB 但读写均为原始字节（默认 52428800 显示为 52428800，用户输入 50 会以 50 字节写入使排除规则失效）。renderField number 分支新增 unit: MiB 支持：回显时字节÷1024²、保存时×1024²。
  - **修复 restart() 三次并发竞态**：串行化分支 this.restartPromise.then(...) 的结果未回写 restartPromise，第三次并发 syncFromSettings 会与进行中的 doRestart 并发启动两个 start()，极端时序下端口空闲但 running=false 的死状态（远程控制停摆需手动重启）。链式结果现回写自身形成真正串行队列。
  - **修复消息向上分页 offset 错位重复渲染**：loadOlder 用本地已加载条数作 offset，会话增长时（桌面端镜像流/另一设备发送）窗口错位导致重复消息。改用服务端返回的绝对窗口下沿推进。
  - **修复设置页 text 字段不回显当前值**：proxy.url/storagePath/model id 等 text 字段此前永远渲染为空；现回显当前值（密钥类保持脱敏占位），空串提交不再覆盖真实配置（跳过并提示）。
  - **修复停止生成时 SSE 恰好断连导致半截内容不可见**：doStop 在 cancel 成功后追加 loadMessages 兜底重载（服务端已落盘）。
  - **修复桌面端删除会话后移动端页签残留**：服务端 handleConversationDelete 新增广播 conversation-deleted（携带 conversationId），移动端收到后关闭对应页签（仅靠分页列表「不在列表即已删」会误删分页之外的会话）。
  - **修复 /api/send 新建会话后流启动失败残留空会话**：本请求刚创建的会话在流启动失败时回滚删除并通知列表刷新。
  - 测试：remoteControl 扩至 194 例（图标闭合路径断言、MiB 换算断言）；全部后端测试 263 套件/2824 例通过。


（暂无未发布改动）

### Fixed（1.7.10dev 补记：远程控制 V7.1——模型管理列表刷新修复 + 图标渲染健壮性加固）
  - **模型管理对话框**：打开即强制重拉模型列表（不再被 modelsLoaded 缓存短路显示空/旧列表），添加/删除模型后列表即时刷新，删除后当前模型标记回填最新值；
  - **图标加固**：HTML 内联 SVG 与 JS 动态图标全部补显式 width/height 属性，CSS 失效场景下退出按钮/加号/工作区加号仍可见；
  - 测试：模型管理全流程 + SVG 属性断言。

### Added（1.7.10dev 补记：远程控制 V7——渠道页内联折叠菜单与桌面端 ChannelSettings 完全同构 + 提示词预设条目编辑器 + 工具页配置折叠 + 图标补全）
  - **渠道页重构**：顶部渠道选择器（选中即当前）+ 当前渠道完整内联表单（全部折叠面板：上下文管理/工具配置/Token 计数方式/高级选项（含思考配置/思考回传/Prompt Caching 子分组）/自定义 Body/自定义标头/自动重试，均带 header toggle 与即时保存）+ 渠道列表卡片保留；
  - **提示词预设条目编辑器**：组装方式二选一（传统模板/预设条目），entries 模式完整条目 CRUD（角色/内容/fakeThought/排序/复制/删除 + Chat History 固定条目 + 从传统模板转换）；
  - **工具页**：最大工具调用次数 + 工具行配置折叠面板 + fileTools 逐工具折叠 + execute_command 逐 Shell 管理；
  - **记忆页**：移除已废弃 partChars/partLines、新增全局/工作区作用域切换与条目行内编辑；
  - **远程控制页**：enabled/port 可编辑；**用量页**：时间范围选择 + cacheCreationTokens/skippedConversations；
  - **图标体系补全**：22 分类导航内嵌 SVG 图标、渠道按钮/chips/toast 图标化、退出按钮 i18n；
  - 服务端：memory workspaceUri 透传、usage range→startTime；测试扩至 196 例。

### Added（1.7.10dev 补记：远程控制 V6——布局重构为桌面版三段式 + 设置面板与桌面端 19 页签逐字段同步）
  - **布局重构（V6）**：删除底部导航，改为桌面版三段式（顶栏含文件/设置入口 + 会话页签条 + 消息区 + 输入区）；文件与设置改为全屏右侧滑入面板，设置面板改为左侧 132px 纵向分类导航 + 右侧卡片表单；
  - **渠道编辑改为桌面端同款 4 子菜单**（基本/上下文管理/工具配置/高级选项），strictToolsEnabled 字段名修正，补齐上下文管理/tokenCountMethod/高级选项约 40 字段（按渠道类型动态显示）；
  - **设置逐字段同步桌面端**：记忆条目管理（增删改查）、用量统计同源数据（7 卡 + 明细 + 刷新）、sound 全字段、appearance 补全、tools 批量开关与工具面板全量、mcp 完整编辑表单与连接/断开、子代理完整 CRUD 表单、prompt 模式管理（新建/重命名/复制/删除 + 每模式字段路径修正）、checkpoint profilePatterns、storage 操作、general 更新/导入导出/应用信息；
  - **服务端新增 14 端点**（mcp 连接/更新/导入导出/存储/记忆）；
  - 测试扩至 182 例。

### Added（1.7.10dev 补记：远程控制 V5——UI 对齐桌面版全量重写 + 设置项补全 + 消息渲染与服务端 schema 对齐）
  - **UI 视觉对齐桌面版（V5）**：`remoteControlUiCss.ts` 按桌面端组件实测数值全量重写——VS Code Dark+ 令牌精确对齐、扁平化极小圆角（2-6px）、8pt 间距系统；消息列表对齐 MessageItem（用户淡蓝底 6%、助手扁平分隔、消息头模型名/时间）、工具卡对齐 ToolMessage（可展开 JSON 参数）、思考卡对齐 MessageRenderBlock（折叠/展开）、输入区对齐 InputArea/InputSelectorBar、页签栏对齐 ConversationTabs（32px + 2px 激活下划线）、设置面板对齐 SettingsPanel（卡片化表单）、会话抽屉对齐 ConversationList。
  - **消息渲染与服务端 schema 对齐**：工具调用识别 `part.functionCall`、思考折叠卡、functionResponse 工具结果卡、附件元数据占位卡（服务端剥离 base64 保留 mimeType/displayName）、消息头 `modelVersion`/`timestamp` 真实键名、删除消息用绝对索引 `msg.index`、流式工具阶段内容实时展示——远控端消息与桌面端/服务端完全对应。
  - **设置项补全**：新增「MCP 服务器」分类（列表/新增/编辑/删除/启用，透传 McpHandlers）与「用量统计」分类（usage.getStats）；渠道编辑补齐流式输出/多模态/严格工具/自动重试/自定义请求体与请求头；修复 5 个死字段（proxy.insecureSkipVerify、outsideWorkspaceAccess×2、execute_command.defaultTimeout、pinned_files.files[]）；补齐 imageGen 默认宽高比/尺寸、memory systemPrompt、apply_diff diffGuardThreshold、prompt 组装模式、smoothStreaming silky 档；依赖支持安装/卸载。
  - **「无法打开新聊天」修复**：移除前端 activeChannelId 空值拦截（服务端 resolveConfigId 兜底）；孤儿流终结块竞态修复——POST 响应回填 conversationId 后立即重放 orphanStreams 缓冲，新页签不再永久卡「生成中」。
  - **服务端**：`/api/send` 会话存在性校验（404 防已删除会话复活）；附件元数据保留。测试扩至 156 例（新端点路由/404 防护/附件元数据/22 分类）。

### Fixed（1.7.10dev 补记：远程控制 V5）
  - 消息渲染层与服务端 ContentPart schema 全面对齐，删除索引/流式工具状态/消息头字段名等历史错位全部修正。

### Added（1.7.10dev 补记：远程控制 V4 全量重写——移动端 UI 架构重构 + 设置字段与桌面端完全对齐 + 稳定性加固）
  - **客户端架构重构（V4）**：`remoteControlUiScript.ts` 整体重写为单一 IIFE + 明确模块分区（工具/API 客户端/内嵌 SVG 图标/状态/视图路由/会话页签/输入区四选择器/文件与工作区/schema 驱动设置页/SSE 看门狗/启动）；全部渲染函数幂等且经 `safe()` 错误边界包裹，任何异常只落 toast + 顶部错误横幅，杜绝"页面随机变空白"（含新增渠道后白屏、闲置白屏等历史故障）。
  - **稳定性加固**：SSE 看门狗（readyState 静默断连 15s 兜底重连、断线退避重连、回前台立即恢复）、服务器 bye/重启后 `probeServerRecovery` 周期性探活自动重连（此前 bye 后页面永久停摆）、全局 `window.onerror`/`unhandledrejection` 兜底；修复 `loadConfigModels` 重复拉取 + 设置页无限重渲染隐患（modelsLoaded 缓存）。
  - **设置页字段与桌面端完全对齐（schema 驱动）**：检查点改 `toolsConfig.checkpoint.*`（此前误写复数键零效果）并补齐消息/工具/排除全量字段；自动总结改用桌面端真实字段；记忆/上下文诊断/沙箱/子代理/系统提示词模式/Token 计数/通用外观字段全部对齐桌面端路径；渠道卡片新增「模型管理」对话框。
  - **HTML/CSS**：新增 `#error-banner` 错误横幅与页签/抽屉/清单/确认条等新控件样式，全部图标内嵌 SVG，零外部依赖。

### Fixed（1.7.10dev 补记：远程控制 V4）
  - **服务端设置写侧密钥占位符剥离**（`RemoteControlServer.ts`）：`POST /api/settings` 与 `config-update` 同语义——`generate_image.apiKey` / `token_count.*.apiKey` 为 `'********'` 或空串不落库；`proxy.url` 含脱敏 `***@` 不覆盖真实凭据。
  - **远程控制测试扩至 143 例**：新增 jsdom DOM 交互测试（四选择器弹层、20 分类切换渲染、检查点/自动总结字段路径断言、新增渠道 modal→POST→不白屏回归、SSE 空闲稳定性、发送透传）；模板完整性测试覆盖脚本全部 id 引用与全部 i18n key 三语言一致性。


### Added（1.7.10dev 补记：远程控制 V2 去虚拟化直连 + 移动端 UI 彻底重构）
  - **远程控制去虚拟化（V2 架构）**：远控端不再注册为 WebviewClientRegistry 虚拟客户端、不再经 MessageRouter 路由——非流式操作由 `invokeHandler` 进程内直接执行 handler 函数（响应直接 resolve，零虚拟客户端开销）；流式操作由远控端专用 StreamRequestHandler 直连执行（与桌面端共享 StreamAbortManager，停止/取消跨端共用同一取消控制器）；移除 `remote-control` 客户端注册与 pending 应答表。
  - **会话列表实时双向同步**：移动端经 SSE `conversations` 事件实时刷新；桌面端经 `conversationsChanged` 广播实时刷新最近对话（远端新建对话不再需要重启应用才出现）。
  - **渠道完整管理（移动端）**：新增/编辑/删除渠道（`POST /api/config-create|config-update|config-delete`），`GET /api/config` 返回完整可编辑配置（apiKey 脱敏，占位串不覆盖已存密钥），含思考强度等高级设置。
  - **模型管理（移动端）**：`POST /api/models-add|models-remove|models-get`。
  - **输入区四选择器**：模型模式 / 渠道 / 模型 / 思考强度（桌面端 InputSelectorBar 同款，思考强度语义与桌面端 buildThinkingLevelUpdates 一致）；`POST /api/send` 支持 configId/modelId/promptModeId 透传。
  - **移动端 UI 彻底重构（V3）**：单文件拆分三模块（i18n+HTML / CSS / Script）；页签全部可关闭（含新对话页签）；图标全部内嵌 SVG；设置页 20 分类；输入区布局修复。
  - **测试**：remoteControl 测试扩至 125 例（渠道 CRUD/模型管理/提示词模式/发送透传/会话变更通知）。
  （详见根目录 CHANGELOG [1.7.10dev]）

### Added（1.7.10dev 补记：多会话并行 + 设置分页 + 流式/落盘修复）
  - **多会话并行（会话页签栏）**：移动端聊天视图新增桌面端 ConversationTabs 同款页签条，多会话同时打开、独立流式状态互不阻塞；新建会话页签、页签可关闭；会话抽屉分页惰性加载（每页 30 + 加载更多）。
  - **设置页分页化**：对齐桌面端 SettingsPanel 19 类侧栏——渠道/通用/代理/工具/文件工具/命令与沙箱/提示词/上下文/记忆/总结/检查点/Token 计数/图像生成/技能/子代理/固定文件/远程控制/存储/依赖，连接状态与访问地址归入「远程控制」、渠道模型管理归入「渠道」。
  - **输入区渠道/模型选择**：输入框上方渠道+模型胶囊（点击弹层切换，`/api/configs|config|model|channel-active`）。
  - **历史/会话列表分页**：`GET /api/messages` 支持 `limit/offset`（默认 120 上限 500，自尾端开窗，滚动回溯）；`GET /api/conversations` 支持 `limit/offset`（默认 30 上限 100）且先按 updatedAt 降序再切片；`POST /api/send` 返回 `streamId` 消除新建会话竞态。
  - **流式批量 chunk 修复**：按桌面端 StreamChunkProcessor 真实装配形状（conversationId/streamId 在 chunk 元素上）解析单/批量流，50ms 节流合并的批量输出完整累积；孤儿 chunk 按 streamId 缓冲补发。
  - **会话摘要落盘修复**：服务器在流终结后自动补齐 `custom.messageCount/custom.preview`（此前远端会话列表计数恒 0/预览为空）。
  - **其他修复**：`[hidden]` 被 display:flex 覆盖导致「巨大加载历史消息挡住对话」；消息删除改用绝对 index；连接断开复位页签流式状态；secRemote 三语言翻译补齐。
  - **测试**：remoteControl 测试扩至 109 例（分页/摘要同步/真实 chunk 形状/UI 模板结构）。
  （详见根目录 CHANGELOG [1.7.10dev]）

## [1.7.10dev] - 2026-08-10

### Added
  - **远程控制大改版——「床上办公」移动端主界面**：控制页升级为三页签自包含 SPA（会话/文件/设置），可操作桌面端真实工作区：
    - 会话页签新增工具确认条（`awaitingConfirmation` → 手机端批准/拒绝，`toolConfirmation` 复用桌面管道）、错误重试（`retryStream`）、删除消息（`deleteSingleMessage`）、Markdown 表格渲染；
    - 文件页签：工作区文件树浏览 + 文本查看/编辑（保存写回真实工作区，`workspace.writeTextFile` 新增 webview handler 并复用工作区包含校验与 10MB 上限）+ 桌面端打开（`openWorkspaceFileAt`）+ 工作区切换（`workspace.setActive`）；
    - 设置页签：连接状态/端口/版本、局域网地址点击复制、渠道模型切换（`models.setActiveModel`）；
    - 桌面端活动编辑器/工作区变化经 SSE `workspace` 事件实时镜像到手机（BackendHost 挂接 vscode 监听器）；
    - 新增 REST 端点（沿用既有 Host/Origin/JSON-only 安全基线 + 形状白名单）；`RemoteControlServer` 与 UI 模板迁入 `backend/modules/remoteControl/` 获得 jest 覆盖（HTTP 集成测试 + UI 模板测试）；
  （详见根目录 CHANGELOG [1.7.10dev]）

### Other
  - **移除 fast-tavern-main 子项目**（81 文件）并清理相关引用；版本号升至 1.7.10dev（详见根目录 CHANGELOG [1.7.10dev]）。


### Added（1.7.10dev 补记）
  - **远程控制端 UI 风格对齐桌面端（VS Code Dark+ 设计令牌）**：移动端控制页重构为桌面端同款视觉（深色默认 + 浅色跟随系统），消息列表改桌面端扁平行式，顶栏/底部页签/弹层/列表选中态全部对齐。
  - **会话侧栏抽屉**：左侧滑出会话列表（新建/切换/重命名/删除会话），对齐桌面端侧栏布局。
  - **消息操作菜单**：长按消息可编辑并重新生成（分支语义）、重新生成（reroll）、重试、删除。
  - **工作区管理补齐**：新增工作区（桌面端文件夹选择框）、移除收藏工作区。
  - **发送键图标修复**：发送/停止按钮内置 SVG 图标并启动即渲染（此前首次加载为空）。
  - **新增 REST 端点**：`POST /api/workspace-add|workspace-remove|conversation-delete|edit-message|reroll`（沿用既有安全基线）。

### Fixed（1.7.10dev 补记）
  - **会话列表恒为空**：`handleListConversations` 改按 `custom.messageCount/custom.preview` 读取（与桌面端同口径），取消按计数过滤。
  - **工作区根目录无法浏览**：目录列举白名单允许空路径（`path=`=根目录），与 FileHandlers 语义对齐。
  - 详见根目录 CHANGELOG [1.7.10dev]。

### Added（1.7.10dev 补记：移动端自选工作区 + 设置页全量补齐）
  - **移动端自选工作区目录**：`GET /api/fs` 服务端目录浏览（仅目录元数据，不读文件内容；盘符列表 + 目录树 + 隐藏项过滤 + 500 条目上限）+ `POST /api/workspace-add` 支持 `fsPath` 直接打开（免桌面端文件夹选择框，桌面端弹窗保留为兜底）。
  - **设置页全量补齐**：`GET/POST /api/settings` 透传桌面端 `getSettings/updateSettings` 管道（深合并语义一致，apiKey/音频资产/代理 URL 凭据响应侧脱敏），覆盖通用/界面/代理/工具启用/自动执行/文件工具/命令沙箱/提示词/上下文/记忆/总结/检查点/Token 计数/图像生成/技能/子代理/固定文件/远程控制/存储/依赖全部设置项；渠道列表新增启用/停用与「设为当前渠道」。
  - **新增 REST 端点**（沿用既有安全基线）：`GET /api/fs|settings|tools|dependencies`、`POST /api/settings|channel-toggle|channel-active|remote-action`。
  - 详见根目录 CHANGELOG [1.7.10dev]。

### Fixed（1.7.10dev 补记）
  - **切换工作区失效**：收藏但未打开的工作区此前 `workspace.setActive` 静默无操作；现按已打开/仅收藏分流（setActive 固定 / openFolder 宿主打开并自动固定），两处皆无时返回 404 明确提示。
  - **设置项不完整（只有渠道）**：按上方 Added 补齐全部桌面端设置项。
  - 详见根目录 CHANGELOG [1.7.10dev]。

## [1.7.9dev] - 2026-08-10

### Added
  - **远程控制（RemoteControlServer）**：设置页新增「远程控制」页签——启用后在局域网监听自定义端口（默认 17532），提供移动端友好控制页（自包含 HTML，随服务器懒加载，关闭时零资源占用）；手机可查看/切换/重命名会话、发送消息、停止生成，流式输出经 SSE 实时回传，桌面端自身会话流式输出同步镜像到手机；移动端以 `remote-control` 客户端身份接入 MessageRouter 复用完整后端管道；安全基线：默认关闭、Host/Origin 校验防 DNS rebinding、POST 仅 application/json、会话读取限已存在会话、SSE 并发上限 + 空闲超时；端口/开关变更即时生效，监听失败可在设置页重试；设置搜索与三语言（en/zh-CN/ja）文案齐全（详见根目录 CHANGELOG [1.7.9dev]）。

### Fixed
  - **远程控制设置页 i18n 键路径错误**：组件文案键误写为 `components.settings.remoteControlSettings.*`，实际语言包层级为 `components.settings.settingsPanel.remoteControlSettings.*`，导致设置页整页显示原始键名。已修正组件与设置搜索索引引用，新增 i18n 键完整性回归测试（详见根目录 CHANGELOG [1.7.9dev]）。
  - **远程控制访问地址过滤虚拟网卡**：局域网地址列表不再展示 Hyper-V/WSL/Docker 等 vEthernet 内部 bridge 地址（172.x.x.x，局域网设备不可达），仅展示真实网卡地址（详见根目录 CHANGELOG [1.7.9dev]）。

## [1.7.8] - 2026-08-10

### Added
  - **聊天输入区「思考强度」快捷下拉框**：位于模型选择器旁，选项覆盖设置页全部档位不裁剪（openai 系 Off/none/minimal/low/medium/high/xhigh/max/ultra/custom；anthropic Off/low…ultra/custom；gemini Off/minimal/low/medium/high，文案保持英文不翻译），与设置页写同一份渠道配置（`config.updateConfig`）双向联动；Off 语义：openai 系/gemini 关闸门、anthropic 显式写 `thinking.type='disabled'`（请求携带禁用参数，后端 formatter 新增 disabled 分支）；openai `none` 保持「不传递 effort 参数」与 Off 区分；下拉选择后经 `settingsStore.configsVersion` 信号通知设置页重载（详见根目录 CHANGELOG [1.7.8]）。

### Fixed
  - **任务栏固定图标启动丢失持久化**：任务栏固定记录的是运行中进程（解压缓存内层 exe `%TEMP%\GrayCode-Portable\GrayCode.exe`）的路径，explorer 直接启动它时无 `PORTABLE_EXECUTABLE_DIR`，userData 回退到临时目录导致「数据丢失」。修复：新增 `portable-home.ts`——正常启动时把外层便携 exe 目录写入解压缓存指针文件 `gc-portable-home`，内层 exe 被直接启动时读取指针回填环境变量，数据解析与安装形态判定恢复一致；不写 `%LOCALAPPDATA%` 固定标记，数据仍在 `<便携 exe 目录>\data`，多实例与便携特性不变，安装版/zip 版不受影响；9 个单测覆盖（详见根目录 CHANGELOG [1.7.8]）。

### Other
  - **上游增量合并说明**：合入上游 3 个通用修复（设置页草稿输入、渠道切换竞态防护、删除索引越界兜底），nightly 渠道相关提交暂不引入（详见根目录 CHANGELOG [1.7.8]）。

## [1.7.7] - 2026-08-09

### Fixed
  - **关闭开屏动画后仍闪现 1-2 帧 Splash 动画**：桌面主窗口无 `__GRAYCODE_STARTUP_SPLASH_ENABLED` 同步注入，`App.vue` 的 `splashActive` 走 `settingsStore.splashEnabled`（此前默认 `true`，等 `getSettings` 往返后才纠正）——首帧静态画面已被 `gc-splash-disabled` 标记抑制，Vue Splash 却仍挂载播放动画直到配置返回。修复：`splashEnabled` 初始值读取与首帧静态画面同一个 localStorage 标记 `gc-splash-disabled`，首帧决定严格一致，关闭动画用户从第一帧起完全不渲染 Splash（详见根目录 CHANGELOG [1.7.7]）。

### Performance
  - **渲染层资源注入并行**：`injectDesktopRendererAssets` 的 theme.css / codicons / overlay.js 文件读取改 `Promise.all` 并行（注入仍按 keyName 隔离串行），省两次跨进程 IPC 往返。
  - **TaskManager 泄漏兜底接线**：`cleanup()` 此前无任何调用点；`registerTask` 惰性启动 unref 的 5 分钟周期清扫定时器，仅补发「已 abort 却未注销」任务的 cancelled 终态（不再按驻留时长强杀长任务，避免伪造取消回执；详见根目录 CHANGELOG [1.7.7]）。
  - **工具声明热路径免全量克隆**：`settingsFingerprint` 改走 `getSettingsRaw()` 裸引用（`SettingsCore`/`SettingsManager` 新增，仅限内部只读），不再每次迭代深拷贝整份设置（详见根目录 CHANGELOG [1.7.7]）。
  - **前端启动链并行化**（共用前端）：`chatStore.initialize` 去重 + `Promise.all` 并行、`App.vue` 并行初始化（详见根目录 CHANGELOG [1.7.7]）。

## [1.7.5.2dev] - 2026-08-09

### Fixed
  - **一键更新按运行形态匹配安装包**：`BackendHost` 为 `UpdateChecker` 注入 `getInstallerKind`（`process.env.PORTABLE_EXECUTABLE_DIR` 存在即便携版）——便携用户优先下载 `GrayCode-Portable-*.exe`，不再被拉进安装版；安装版用户优先 `GrayCode.Setup.*.exe`。配套版本归一化（`1.7.5-2dev` ↔ `1.7.5.2dev`）与 stable/dev 通道隔离见根目录 CHANGELOG [1.7.5.2dev]。
  - **版本号升至 1.7.5.2dev**（根 package.json 1.7.5.2dev；electron-app package+lock 1.7.5-2dev，electron-builder 仅接受合法 semver，点分四段会被 `fixVersionField` 拒绝）。

## [1.7.6.1] - 2026-08-09

### Fixed
  - **自动应用 diff 后高频弹出「diff is no longer pending」错误提示且无法手动关闭**：前端 `ToolMessage` 倒计时与后端 `DiffManager` 自动保存定时器构成「双自动接受竞态」——后端先到点接受，前端倒计时到点再发 `diff.accept` 命中 `DIFF_NOT_PENDING`，error toast 只能等 10s 超时消失。修复：前端倒计时改为纯展示（到点不再发 accept，后端定时器为唯一权威），`DIFF_NOT_PENDING` 按良性终态本地结算（不弹提示）；变更查看面板 `diffStore.act` 同步处理。详见根目录 CHANGELOG [1.7.6.1]。
  - **窗口标题「GrayCode — No workspace」未多语言化**：`menu-i18n.ts` 新增 `windowTitleNoWorkspace` 键，`setWorkspaceFolders` / `restoreWorkspace` 的标题占位文案随界面语言（zh-CN / en / ja）。
  - **diff 错误文案未多语言化**（webview 侧）：`DIFF_NOT_PENDING` 等错误码消息接入 `webview.errors.*` 三语字典（详见根目录 CHANGELOG [1.7.6.1]）。

## [1.7.6] - 2026-08-09

### Fixed
  - **「未打开工作区」提示在开场动画播完之前弹出**：toast 改由渲染层 `splashDone` 信号门控（BackendHost 积压待发，20s 超时兜底）；main.ts 工作区恢复失败路径不再重复发送（与 webviewReady 握手路径去重，此前两条路径会双弹）；提示文案本地化（zh-CN / en / ja）。
  - **工作区恢复失效回归（1.7.5 懒加载引入）**：`createBackend` 改为动态 import 后 `createWindow` 执行时 `backendHost` 仍为 null，原「恢复上次工作区」逻辑被静默跳过；恢复逻辑抽为模块级 `restoreWorkspace()`，在 BackendHost 就绪后（懒加载回调内）执行（详见根目录 CHANGELOG [1.7.6]）。
  - **文件夹选择对话框暴露 `dialogs.selectFolder` 键名**：`WorkspaceHandlers.openWorkspaceFolder` 的 showOpenDialog 键缺 `webview.` 前缀，缺失回退把键名字面量显示到标题/按钮上；已修正（详见根目录 CHANGELOG [1.7.6]）。
  - **应用菜单未多语言化**：新增 `electron-app/src/menu-i18n.ts` 独立小字典（zh-CN / en / ja，不引入 backend 语言包以保住主进程壳体积），File / Edit / View / Help 及全部下拉项、文件夹选择对话框、About 对话框随界面语言；启动读设置文件 `graycode.ui.language`（auto 回退 `app.getLocale()`），语言切换经渲染层 `app.setMenuLanguage` 消息即时重建菜单（BackendHost → main.ts `onMenuLanguageChange`）。
  - **语言切换后部分 UI 冻结在旧语言 / 启动首帧语言错位**（渲染层 i18n）：`t()` 缓存短路导致计算属性丢失语言响应式依赖（工作区选择器标签等冻结在首帧语言）；界面语言改为 localStorage 同步恢复（首帧即用已保存语言）。详见根目录 CHANGELOG [1.7.6]。

### Added
  - **设置页「通用」新增「工作区行为」**（`ui.workspaceBehavior`：`restore` 默认 / `none`）：`none` 时主进程跳过工作区恢复，BackendHost 不再弹「未打开工作区」启动提示。

### Performance
  - 未改动启动热点：菜单语言为启动时单次读 JSON + 一条轻量 IPC；`splashDone` 为渲染层单向上报信号（宿主回 success 应答但不被渲染层 await，不阻塞任何启动流水线）；无新增同步阻塞（窗口出现/后端就绪与 1.7.5 持平）。

## [1.7.5] - 2026-08-08

### Performance
  - **便携版 exe 解压缓存**（`patch-portable.mjs` + `portable.unpackDirName = GrayCode-Portable`）：NSIS 启动器缓存优先——首次启动解压后写入 gc-cache-key（随机 build ID），二次启动命中缓存直接运行、退出不删缓存（实测窗口出现 3.0s → ~0.5s）；exe 替换/重下（build ID 变化）自动失效重解压；载荷仍为 LZMA，体积不变。详见根目录 CHANGELOG [1.7.5]。
  - **主进程三包拆分 + BackendHost 懒加载**（`build.mjs`）：main.js（主进程壳）/ host/BackendHost.js（后端宿主，动态 import 懒加载）/ vscode-shim.js（共享实例）；渲染层消息在 BackendHost 就绪前缓冲、就绪后补投；`spellcheck: false` 省渲染进程初始化。
  - 解压算法对比实测（同机）：LZMA 95MB/2.27s、store 313MB/1.59s、zip(DEFLATE) 130MB/2.0s——保持 LZMA 体积 + 缓存方案。

### Fixed
  - **更新检查：禁用自动检查后手动检查失效**（`UpdateChecker.check` force 绕过 isCheckEnabled 闸门，自动检查开关只约束启动时检查；见根目录 CHANGELOG [1.7.5]）。

### Changed
  - 版本号 1.7.5.1dev -> 1.7.5（package.json / package-lock.json）。

## [1.7.5dev] - 2026-08-08

### 同步上游
  - **同步上游 Gray-Code 25 个提交（962d496..8ed8739）**：20 个本地适配 commit 按模块合入（checkpoint/mcp/settings/conversation/memory/chat/subagents/modules 健壮性、总结保留预算、思考强度档位 + TTFT、后台回执提前投递、formatter/regexGuard 修复、webview 处理器加固、前端缺陷批次）；其余本地已有等价实现保留本地，上游 SHA 经 -s ours 记录消除 fork behind 计数。详见根目录 CHANGELOG [1.7.5dev]。
### Added
  - **用户可修改对话标题**（1.7.4，详见根目录 CHANGELOG [Unreleased]）：历史页/首页对话列表悬停新增「重命名对话」按钮（InputDialog 弹窗），走 `conversation.setTitle` 持久化到 meta.json，成功后同步列表与已打开标签页标题；新增 store 回归测试 4 例。
  - **设置页「自动执行」给 Diff 审阅类工具提供「自动批准」开关**（1.7.4）：write_file / apply_diff / insert_code / delete_code 徽标旁新增真实开关，读写「应用diff 设置」的 autoSave（四工具共用），显示「自动批准 / 需确认」状态。
  - **设置页子菜单折叠**（1.7.4）：「自动执行」与「工具」页签分类子菜单头部可点击折叠/展开。

### Fixed
  - **沙箱工具描述与分类汉化**（1.7.4）：工具管理页/自动执行页 sandbox 描述缺失 `toolDescriptions.sandbox` i18n 条目、回退英文声明，现三语补齐；工具管理页沙箱分类名缺失 `toolsSettings.categories.sandbox` 条目（显示原始 key），三语补齐。
  - **apply_diff 汉化统一为「应用diff」**（1.7.4）：工具显示名、工具注册表 label（消息卡片）、消息卡片标题、审阅面板标题统一为「应用diff」；自动执行页「Diff 审阅管理」→「差异审阅管理」、文案中的 "Apply Diff" 替换、「Diff 警戒值」→「差异警戒值」。
  - **设置搜索补齐 apply_diff 自动应用条目**（1.7.4）：搜索索引新增 `apply-diff-config` 锚点条目（关键词含 自动应用/自动批准/auto apply/auto approve/应用diff），跳转时自动展开目标工具配置面板（新增 `tools/toolConfigFocus.ts` 展开信号 + 双重 nextTick 定位），消除静默回退。
  - **对话内禁止切换工作区——切换工作区 = 打开绑定新工作区的新对话**（详见根目录 CHANGELOG [Unreleased]）：
    - 移除下拉切换/打开文件夹对当前对话的重绑定（对话绑定不再被强行切换改写，修复标题与绑定错位）；
    - 切换工作区打开绑定新工作区的新对话（空白标签页），同工作区空白标签复用、首个消息前不持久化——不产生对话堆积；
    - 历史页「当前工作区」筛选展示新工作区下的对话列表；
    - 新增 `workspaceSwitch.test.ts` 回归测试（7 例）。
  - **对话绑定工作区健壮性修复**（详见根目录 CHANGELOG [Unreleased]）：
    - `setWorkspaceUri`/`createConversation` workspaceUri 归一化（null/空白 → 解绑，防字面 null 与脏 URI 持久化）；
    - 后端 H4 自动建会话保留已存在元数据（标题/绑定/自定义字段），已绑定对话不被调用方 hint 覆盖；
    - `syncConversationWorkspaceUri` 锁定展示修复 + TOCTOU 竞态修正；
    - 工作区 URI 匹配口径跨平台对齐（fsCaseSensitive 由扩展端下发，仅 Windows 大小写不敏感）；
    - 新增回归测试（workspaceBindRepair / workspaceSync / WorkspaceSelector 大小写敏感）。
  - **对话绑定工作区锁定 + 下拉切换工作区修复**（详见根目录 CHANGELOG [Unreleased]）：
    - 打开对话/切换标签页锁定工作区到对话绑定工作区，不再因绑定工作区未打开而静默重绑定；
    - 顶部工作区下拉切换修复：Windows 大小写不敏感匹配（规范 URI 固定）、未打开工作区不再误解除固定、打开收藏工作区后重绑定当前对话、绑定未打开工作区以锁定条目展示；
    - UI smoke 新增 workspaceSelector 步骤。
  - **LLM 前缀缓存命中率修复（消息插入不再吃缓存，1.7.4）**（详见根目录 CHANGELOG [1.7.4]）：
    - 根因：消息插入（chat.sendInterruptMessage / agent→main 信箱）注入的 agentInbox 随工具结果落盘，旧实现跨轮剥离导致同一 tool_result 内容在回合边界翻转，Anthropic cache_control / OpenAI prefix caching 整段前缀失效；
    - `cleanFunctionResponseForAPI` 移除 agentInbox 剥离（常驻历史，跨回合字节稳定）；子代理路径同步删除 `stripReplayedAgentInboxForModel`；
    - 消息插入功能补齐：`serializeToolResultForLLM` 文本路径（execute_command 等）此前不含 agentInbox，模型看不到插入的消息，新增 `[Agent inbox messages]` 文本段统一渲染。

### Changed
  - 沙箱功能完整化批次（详见根目录 CHANGELOG [Unreleased]）：声明缓存指纹纳入沙箱开关、空白名单语义统一、超时杀进程 SIGKILL 升级、输出内存护栏、GBK 解码降级、设置页 i18n 键路径修正与搜索索引补齐等。

## [1.7.3] - 2026-08-07

### Added
  - 新增沙箱（Sandbox）工具与设置栏目（详见根目录 CHANGELOG [1.7.3]）：LLM 可在隔离临时目录中安全运行代码片段，支持 Python/JavaScript/Bash/PowerShell/sh，含超时、输出上限与语言白名单。

### Changed
  - 版本号 1.7.2dev -> 1.7.3（package.json / package-lock.json）。

## [1.7.2dev] - 2026-08-07

### Changed
  - 版本号 1.7.1 → 1.7.2dev（package.json / package-lock.json）。
  - 插件本体同步上游 9644238 安全加固与修复批次（详见根目录 CHANGELOG [1.7.2dev]）：
    手动创建存档点、子代理确认门/上下文裁剪（含 this 绑定修复）、流式缓冲 64MB 无进展上限、
    checkpoint 双文件配对一致性、retry 截断、单轮手动总结放行、多模态占位判定统一、
    分支切换器提前刷新、run-logs.zip 忽略。
  - 桌面端代码优化批次（详见根目录 CHANGELOG [1.7.2dev]）：
    `graycode://` 协议缓存命中重 stat 比对 mtime（rebuild 不再返回旧 bundle）；
    `pendingToasts` 100 上限 / `toolDiffIds` 500 上限驱逐；
    build.mjs 补 `process.env.NODE_ENV` define；
    未捕获异常 detail 脱敏、IPC type 校验、patch-dist marker 幂等、clipboard 错误日志。

## [1.7.1] - 2026-08-07

### Added
  - 渲染层 native op 白名单：`graycode:native` IPC 仅放行前端实际使用的 `workspace:pickFolder`（安全收口，防 XSS 失守后触达剪贴板/路径探测/shell）。
  - 主进程 `unhandledRejection` 日志脱敏（遮蔽 apiKey/token 等密钥字段 + 截断）。

### Changed
  - vscode-shim 稳定性：`vscode.diff` 预览路径二次 `decodeURIComponent` 移除（含字面 `%` 路径不再抛 URIError）；`workspace.fs.copy` 遵守 overwrite 契约（缺省不再静默覆盖）；`Uri.parse` 死代码清理。
  - builtinLsp：未知扩展名默认不解析（不再回退 TS 正则产出伪符号）；引用定位预计算行偏移 + 复用已读内容（大文件多匹配 O(n·m) → O(n)）；移除共享 `g` 正则 `lastIndex` 全局状态。
  - BackendHost：diffManager 状态监听退订入 unsubscribers（dispose 移除，防泄漏）；dispose 清空 diff 映射缓存；`require('events')` → `import { EventEmitter }`。
  - 自定义协议热路径缓存命中免 stat；前端入口体积 -31%（面板异步组件化，详见根 CHANGELOG [1.7.1]）。

### Tests
  - backend jest 235 套 / 2442 用例通过；frontend vitest 69 文件 / 648 用例通过；tsc --noEmit（根 + electron-app）与 vue-tsc 全绿；esbuild 生产构建通过；GRAYCODE_UISMOKE 真实 UI 冒烟全绿（rendererErrors 为空）。

### Fixed（1.7.1 补丁）
  - 修复回复查看器渲染期空指针（`props.value.rawJson` 于 value 初始 null 时抛 TypeError）导致消息列表 UI 偶发丢失：`ResponseViewerDialog` value prop 改可空 + 全量可选链兜底（详见根 CHANGELOG [1.7.1] Fixed）。
  - 懒加载面板 chunk 加载失败自动重试（便携版/杀软/临时目录清理场景不再静默空白）。

## [1.7.0] - 2026-08-07

### Merged
  - 增量合入上游 `b968953..2f3155d`（11 提交，fork 保持；backend/webview/frontend 公共部分，详见根 `CHANGELOG.md` [1.7.0]）：高 tps/代码块渲染吸底优化（wheel 冷静期 + 微任务读回）、设置页保存提示词误报失败修复（慢 handler 非阻塞化）、排队消息提前投递（P1，动作边界立即投递）、历史截断后孤儿 functionCall 修复（写时根治，与桌面端 BR-07 读时过滤互补）、渠道设置支持更改渠道类型（下拉框 + 后端按新类型重建）、fakeThought 伪造思考过程 + 思考回传配置合并、根消息编辑重生成（TREE-03-R）+ keep 模式修复、代码块复制按钮修复、`checkForUpdates` contribution 注册；未单独应用上游 CHANGELOG/docs 提交（本地 fork 版自维护）
  - 适配说明：`processQueue` 保留桌面端去重回队首与终结 toolIteration 投递（防审批门闸卡死）；`ConfigManager.updateConfig` 类型重建路径保留桌面端 `resolveModel` 模型回退；`MessageRouter` 非阻塞集合保留桌面端独有条目（workspace.openFolder / chat.awaitConversationIdle 等）；`orphanFunctionCallRepair.test.ts` 播种改为经 manager 写路径（桌面端 historyCache 缓存一致性）

### Tests（1.7.0）
  - backend jest 235 套件 / 2442 用例、frontend vitest 69 文件 / 648 用例、三仓 tsc --noEmit 全绿；新增 `queuedMessageEarlyEmit.test.ts`（12）、`orphanFunctionCallRepair.test.ts`（7）、`ConfigManager.updateConfig.test.ts`（11）、`messageRouterNonBlockingBehavior.test.ts`、`promptSaveChain.test.ts`、`toolIterationThoughtPolicy.test.ts`、`vscodeSettingsStorageRegisteredKeys.test.ts` 等

## [1.6.9] - 2026-08-07

### Merged
  - 增量合入上游 `70ecbb3..cf9330d` + 80e9de7 修正版（backend/webview/frontend 公共部分，详见根 `CHANGELOG.md` [1.6.9]）：记忆隔离作用域加固（只读不建目录 / scope 显式参数 / 不静默回退全局 / T= 快照重试）、H4 自动建会话即绑定工作区、记忆设置页作用域配置隔离（`listMemoryScopes` 当前激活工作区优先）、子代理工具轮幻觉剥离、nodeIdCache epoch 写链守卫、存储统计纳入记忆目录；80e9de7 以上游修正版合入（混合形态 tool 消息拆分 + 日常形态回归防护，上游原版会破坏 function_call 模式）

### Fixed
  - 修复 `memory_wake` 跨作用域 snapshotT 不匹配静默丢内容（改用该作用域当前总数重试）
  - 修复只读记忆工具隐式创建 `memory-workspaces/<hash>/` 目录的磁盘副作用
  - 修复工作区记忆解析失败静默回退全局的跨工作区污染（改为显式报错）
  - 修复自动创建会话未绑定工作区导致记忆工具回退全局（H4）
  - 修复子代理失败/空响应时 partialResponse 携带幻觉预生成文本
  - 修复混合形态消息（同消息 call+response）转换时 functionResponse 被吞（80e9de7 修正版）

### Changed（1.6.9 迭代二，公共部分详见根 `CHANGELOG.md`）
  - **子代理界面可选择模型**：设置 → 子代理「模型」下拉框实时拉取 provider 模型列表 + 渠道默认模型兜底（此前选项恒为空，只能选渠道）；新建子代理对话框补齐模型选择
  - **全局 diff 绑定对话 + gzip 无损压缩**：diff 内容落盘到对话目录并写入归属索引（删除对话即可清理），不再无限写入 `__global__`；gzip 压缩后磁盘占用降低 3-5 倍；旧版明文文件读取兼容
  - **`memory_wake` 分页/续读历史残留移除**：单次输出双作用域全部可用记忆，移除 part/snapshotT 续读机制与 partChars/partLines 配置项
  - **稳定性修复**：流式终结事件视图缺失不丢（占位消息不再永久「生成中」）、waitForIdle 超时兜底、会话删除后幽灵分支文件拦截、`maxIterations=-1` 工具循环硬性兜底（迭代/墙钟上限）、早启动工具系统异常不再伪装成工具失败、流式重试非内容 chunk 不再重复产出、子代理默认运行时长常量统一
  - **diff 存储压缩/索引层健壮性加固（复扫修复）**：索引写链单次失败自愈不再永久失效；写入顺序改「先索引后文件」（崩溃窗口不产生永久孤儿文件，幽灵索引按 ENOENT 自愈删除）；索引写失败回退 `__global__`；统计口径修正；路径迁移重置索引缓存

### Tests（1.6.9 迭代二）
  - backend jest 226 套件 / 2305 用例、frontend vitest 63 文件 / 610 用例、tsc 与生产构建全绿

## [1.6.8] - 2026-08-06

### Fixed
  - **对话工作区独立（已关闭的绑定工作区仍然生效）**：桌面版切换「打开的工作区」后，绑定工作区的文件夹从 `workspaceFolders` 移除，工具路径解析静默回落到当前打开的工作区——对话上下文与工具读写不一致（backend/webview 公共部分，详见根 `CHANGELOG.md` [1.6.8]）：解析层新增虚拟工作区能力，绑定工作区关闭后工具/文件树/搜索/命令仍限定原工作区
  - **打开/保存工作区（多工作区收藏）桌面版失效的根因修复**：`vscode-shim` 的 `showOpenDialog` / `showSaveDialog` 此前把 native 层 Electron 形状（`{ filePaths, canceled }` / `{ filePath, canceled }`）原样返回，而调用方按 VS Code 契约消费（`result.length` / `result[0].fsPath` / `result.fsPath`）——工作区选择器「打开工作区文件夹」弹窗选完目录后永远被判为取消，收藏列表既存不进也打不开，存储路径选择与设置导入/导出同受其害。现 shim 统一转换为 VS Code 契约（`Uri[] | undefined` / `Uri | undefined`），桌面版工作区收藏「保存 + 打开 + 重启保留」链路端到端打通
  - **设置导入/导出对话框 filters 形状不匹配（同族）**：`native.ts` 新增 `normalizeDialogFilters`，把 VS Code 对象形状的 `filters` 转换为 Electron `[{ name, extensions }]` 数组，导入/导出对话框的 JSON 过滤恢复生效
  - **桌面版 `env.openExternal` 拒绝 `file:` URI**：shim 对 `file:` 方案的 Uri 改走 `shell:openPath`（「打开 Skills 目录」等按钮恢复可用）
  - 版本号 1.6.8，electron-app/package.json 同步（详见根 `CHANGELOG.md` [1.6.8]）

### Added
  - 设置页设置项搜索（frontend 公共部分，详见根 `CHANGELOG.md` [1.6.8]）：桌面版同样生效——搜索框 + 结果下拉 + 侧边栏命中高亮 + 跳转定位闪烁

## [1.6.6] - 2026-08-06

### Added
  - **工作区选择器收藏（多工作区收藏列表）**：顶部栏文件夹图标下拉重写为自定义菜单，支持收藏多个工作区文件夹（globalState 持久化，跨窗口/重启保留）、条目 × 一键移除、底部「打开工作区文件夹…」加号入口；新增 webview 处理器 `workspace.getSaved` / `workspace.removeSaved` / `workspace.openFolder`，Electron 主进程新增原生操作 `workspace:openFolder`，vscode-shim 支持 `vscode.openFolder` 命令——收藏工作区点击即打开（替换当前工作区并持久化到 workspace state、窗口标题同步更新），三语文案补齐（公共部分详见根 `CHANGELOG.md` [1.6.6]）

### Changed
  - **仓库改名同步**：`czocelot/Gray-Code-ocelot` → `czocelot/Gray-Code-Desktop`（electron-app/package.json 的 author.url / homepage；其余 README/设置页链接同步，详见根 `CHANGELOG.md` [1.6.6]）；桌面版构建产物版本同步为 v1.6.6

### Fixed
  - **多对话并发编辑多工作区**（backend 公共部分，详见根 `CHANGELOG.md` [1.6.6]）：checkpoint 存档按对话绑定工作区裁剪快照与文件锁范围（不再持有全局根锁阻塞其他工作区的写工具）；写锁 key 按对话工作区解析为绝对路径（消除跨工作区同名相对路径的误冲突/漏锁）——桌面版多 tab 并发流式 + 多工作区并行编辑由此端到端可用

## [1.6.4] - 2026-08-05

### Merged
  - 同步合入上游 49a37f2..10c565c（PR #11/#13：启动动画、TPS 实时可视化与流式平滑输出、上下文预算三层重构、diff 行级差分缓存、子代理 transcript 索引投影、fork 性能优化回移植）：详见根 `CHANGELOG.md` [1.6.4]；桌面版构建产物版本同步为 v1.6.4

### Changed
  - 工作区文件树 30s TTL 缓存（gitignore mtime 失效）、`getMetadataLight` 缓存命中改 `structuredClone`、`getCustomMetadata` 走 metaCache、`getMetadata` fallback 回填缓存、SubAgent flushPersist 单次原子写、分支图内存缓存、HistorySegmentCache 字节估算改抽样、i18n 占位符正则缓存、工具结果合并/toolLocalization 收敛、消息项 content-visibility、ToolMessage 倒计时 50→200ms、Shell 可用性缓存 5 分钟 TTL、流式热路径诊断日志加性能开关（以上均为 backend/frontend 公共部分，详见根 `CHANGELOG.md` [1.6.4]）
  - Electron 主进程/预加载脚本生产构建压缩（`minify: true`，关闭 sourcemap）：安装体积与启动解析时间下降
  - `readRootPackageMetadata` memoize（打包后 package.json 不变，公告/版本检查不再重复同步读盘）；`__setWorkspaceFolders` 差集事件（修复技能重复扫描与移除不清理）；dialog/reload 对已销毁窗口加固
  - `build.mjs` 支持 `--dev`（sourcemap/未压缩）与 `--watch`；新增 `typecheck` script（首次接入即修复工作区变更监听从未 dispose 的隐患）；author 补 email 字段（Linux deb maintainer）
  - 前端主入口分包（vue/highlight/katex vendor chunk，主入口 2.38MB→1.55MB，mermaid 保持懒加载）；公告 CHANGELOG 解析 mtime 缓存（backend 公共部分）

### Fixed
  - 移除无引用的运行时依赖 `@vscode/codicons` 与 `nanoid`（根 package.json，详见根 `CHANGELOG.md` [1.6.4]）
  - 设置持久化丢失（自动执行/工具策略/预设条目开关重启回滚）：VSCodeSettingsStorage 快照改存深拷贝 + 各写点整体替换对象（backend 公共部分，详见根 `CHANGELOG.md` [1.6.4]）
  - 原始记忆条目新增单条删除（设置页此前无删除入口；MemoryManager.deleteEntry + deleteMemoryEntry handler + 三语确认框，详见根 `CHANGELOG.md` [1.6.4]）

## [1.6.3] - 2026-08-05

### Merged
  - 同步合入上游 49a37f2（PR #10：子代理续跑同 run 身份与 transcript、分支树面板重构为轨道式泳道「完整消息图」+ 工具分类分组、总结模型透传（手动/自动/独立总结渠道）、上下文管理关闭时手动总结边界生效、MCP server ID 可读化）：详见根 `CHANGELOG.md` [1.6.3]；桌面版构建产物版本同步为 v1.6.3

### Changed
  - 默认对话标题自动附加工作区名（格式 `标题 [工作区名]`，无工作区时不加）：多项目同时编辑时对话列表 / 标签页 / 历史页可按项目区分（前端公共部分，详见根 `CHANGELOG.md` [1.6.3]）

### Fixed
  - 多工作区一致性修复（前端公共部分）：切换绑定工作区的对话时同步激活工作区、历史页「当前工作区」筛选纳入未绑定对话、工作区重绑定失败回滚、分支对话创建不再错误兜底激活工作区（详见根 `CHANGELOG.md` [1.6.3]）
  - 性能优化（backend 公共部分）：`getMetadataLight` 走 metaCache 免磁盘 IO（对话列表 / 用量统计 / 检查点查询受益）、`usedTokens` 单趟逆序扫描、消息占位定位 Map 索引化（详见根 `CHANGELOG.md` [1.6.3]）

## [1.6.2] - 2026-08-05

### Fixed
  - 修复退出不等待 `BackendHost.dispose()`（异步写队列被截断，设置/对话/用量落盘中途丢失）：`before-quit` preventDefault + await dispose + 10s 超时兜底 + `app.exit(0)`（macOS 关窗不退出语义保留）
  - 修复 `mainWindow.loadURL()` 无 catch：页面加载失败（损坏安装/资源缺失）时 unhandled rejection 直接崩主进程，改为弹错误对话框后退出
  - 新增单实例锁：便携版/安装版重复启动会并发写同一 `data/` 目录（多文件非原子写，配置互相覆盖、memento 丢失）；`requestSingleInstanceLock` 未获锁即退出，`second-instance` 聚焦已有窗口
  - 修复主进程无 unhandledRejection 保护（Node 22 默认终止进程）：入口安装只记录不崩溃的守卫（EPIPE 由既有守卫兜底）
  - 修复 IPC 消息队列无超时：任一阻塞 handler 等渲染层回复永不到达（toast 未渲染/面板隐藏/渲染层重载）时整条队列死锁，后续全部 IPC 永久挂起；每条消息加 60s 超时并回 `HANDLER_TIMEOUT` 错误
  - 修复 `pendingToasts` 只增不删：showMessage/showQuickPick/showInputBox 的等待 Promise 无 TTL，泄漏挂起；加 5 分钟 TTL 自动 resolve(undefined)（调用方按取消处理）并清理定时器
  - 修复 `vscode-shim` 硬编码 `version: '1.99.0'`：改为读取根 `package.json` 版本，与扩展真实版本同源
  - 修复 `JsonFileMemento.update` 非原子写：并发 update 交错写盘互相覆盖丢更新、写一半崩溃留下损坏 JSON（下次启动静默清空）；改为 tmp+rename+串行写队列（与 JsonConfigStore.save 同款）
  - 修复安装版数据目录写入受保护位置（Program Files 等）时数据静默丢失：写入前探测可写性，不可写回退 `appData/GrayCode` 并打印明确错误日志
  - 公告版本解析：CHANGELOG 正则不支持 `## [1.3.1-1]` 预发布条目、重复版本号重复展示；正则支持可选预发布段、compareVersions 遵循预发布 < 正式版、重复版本去重（backend 公共部分，详见根 `CHANGELOG.md` [1.6.2]）
  - 同步合入上游 PR #9 与全仓审查修复（backend/frontend/webview 公共部分）：详见根 `CHANGELOG.md` [1.6.2]；桌面版构建产物版本同步为 v1.6.2

## [1.6.1] - 2026-08-05

### Fixed
  - 修复主进程 stdout/stderr EPIPE 崩溃：输出重定向到管道且读取端提前关闭时，Node 把后续 `console.log` 的 EPIPE 当未捕获异常，Electron 主进程弹错崩溃（e2e 大量日志复现）；入口挂 stdout/stderr 错误守卫，仅吞 EPIPE
  - 修复 `BackendHost.previewToSessionId` 无界增长（500 条 FIFO 上限）
  - 修复 auto-open diff 路径 `resolveOriginalContent` 拿到空 previewId（计算提前，去掉对 filePath 兜底的隐性依赖）
  - 修复 `vscode.diff` shim 的 `preview` 字段语义反转（`options?.preview === true`）
  - 修复 dialog 无窗口时 `win!` 传 null 抛 TypeError（退化为无父窗口对话框）
  - 修复 `chat.awaitConversationIdle` 阻塞整条消息队列（加入 NON_BLOCKING_MESSAGE_TYPES）与前端等待无超时（20s 超时放弃本次 flush 重试，绝不提前写入回执）
  - 修复 `StreamAbortManager` 退休旧流 delete 且无新流接管时不唤醒 idleWaiters（纯停止场景后台回执永久挂起）
  - 同步合入第一/二轮全仓审查修复（backend/frontend/webview 公共部分）：详见根 `CHANGELOG.md` [1.6.1]

## [1.6.0] - 2026-08-05

### Merged
  - 同步合入上游 c7d2e16（PR #8：分支 UI/流式竞态/上下文裁剪 fallback 稳定/总结请求去图/编辑保持当前分支/工具安全）：详见根 `CHANGELOG.md` [Unreleased]；桌面版公告/版本信息（扩展 stub）同步为 v1.6.0

### Fixed
  - 修复打包版（安装版/便携版/zip）通用界面版本号恒为 0.0.0：打包产物只包含 `dist/`，根 `package.json`（运行时版本唯一来源）与 `CHANGELOG.md` 未被打入，所有版本读取（设置页应用信息、About 对话框、版本更新公告）都落到兜底 `0.0.0`，公告逻辑因版本恒等而永不弹新版本更新内容；现在 electron-builder `extraResources` 追加根 `package.json` 与 `CHANGELOG.md`（`resources/package.json`、`resources/CHANGELOG.md`），运行时读取路径不变即可拿到真实版本号与变更日志
  - 修复便携版（GrayCode-Portable-*.exe）数据目录解析错误：portable 启动器把程序解压到 `%TEMP%` 运行并在退出后整目录删除，`app.getPath('exe')` 指向的是临时目录——按旧逻辑数据目录落在临时目录里，每次退出全部数据（设置/会话/记忆/用量）丢失、更新替换 exe 后也表现为「全新应用」且无法核对版本；现在检测到 `PORTABLE_EXECUTABLE_DIR`（启动器注入的便携 exe 实际所在目录）时数据写入该目录旁 `data/`，与安装版/zip 语义一致（复制应用目录即得独立实例），替换 exe 升级后数据保留

## [1.5.2] - 2026-08-04

### Merged
  - 同步合入上游 150a287（分支 reroll/编辑前端主流程接线、删除消息同步分支图、后台回执上下文骤降修复、子代理工具本地化）：reroll/编辑分支流的候选切换、后台回执上下文骤降修复与分支流失败可重试等详见根 `CHANGELOG.md` [1.5.2]；桌面版公告/版本信息（扩展 stub）同步为 `czocelot.graycode` / v1.5.2

## [1.5.1] - 2026-08-04

### Added
  - 代码查看面板自动打开工作区文件树：面板打开即列出工作区根目录（复用新 IPC `listWorkspaceDirectory`，工作区包含校验 + 默认忽略 `.git`/`node_modules`/`dist` 等重型目录），目录懒加载展开、文件点按即查看代码；工具栏新增文件树开关与刷新按钮；相对路径打开改为拼接工作区根 URI（修复 `file://相对路径` 被解析成 authority 导致工作区文件无法打开的问题）
  - 变更查看面板展示并比对上一轮变更：已处理（已接受/已拒绝）条目在关闭面板后保留，重新打开可继续查看与比对历史 diff；条目按「轮」分组（连续推送为同一轮，间隔超过 2s 视为新一轮），文件列表显示「第 N 轮」轮次分隔；全部处理完毕后显示提示条；新增「清空历史」按钮

### Fixed
  - 修复已接受的变更通过工具卡「查看差异」再次打开时状态被重置为待处理、重新出现接受/拒绝与全部接受/全部拒绝按钮：已处理条目保持已解决状态，且非待处理条目不渲染接受/拒绝按钮，历史变更只读查看与比对
  - 修复 SSE 心跳事件污染解析累积器导致长流被误判失败并反复超时重试：`data: keep_alive`/`keep-alive`/`ping`/`heartbeat` 等非 JSON 心跳行不再混入跨行 JSON 累积，后续真实事件可正常解析，纯心跳流结束时不再误入错误详情（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复代理 CONNECT 后 socket 空闲定时器残留把长流掐断：握手成功即 `socket.setTimeout(0)` 解除固定超时，流的空闲超时统一由可重置计时器管理（收到任何字节都会续期）
  - 修复 LLM 模块缓存保活未正确判定成功 + 与流空闲超时脱节：非 2xx 保活响应不再误报成功（瞬时失败自动重试一次）；首个保活提前到「流空闲超时前 10 秒」并成功后刷新流空闲超时，上游静默思考期间流不再被固定超时掐断（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复重试成功事件过早触发（重试页面在重试请求完成前消失）：`retrySuccess` 改为本次尝试流真正结束后广播；修复请求级 `retryStatusCallback` 从未被读取（SubAgent → Monitor 重试状态路由失效）；新增 ChannelManager 重试链路回归测试 4 例与重试面板生命周期前端测试 5 例（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复超时重试面板近乎透明、可读性差：重试面板/头部/错误块全部改为不透明主题色背景
  - 新增变更查看 Store 单元测试 7 例（详见根 `CHANGELOG.md` [1.5.1]）

## [1.5.0] - 2026-08-04

### Security
  - 修复 `graycode://` 自定义协议可读取用户数据目录（含 API Key 与全部对话历史，默认 `data/` 位于 REPO_ROOT 内）：服务根收窄为静态资源白名单（`frontend/dist`、`resources`、`renderer`），用户数据目录显式排除；hostname 强制为 `local`（`graycode://evil/` 拒绝）；500 错误返回固定文案，不再向渲染层回显内部路径/错误细节
  - 修复 openPath/showInFolder 可执行扩展名黑名单不完整：补充 `.hta` / `.lnk` / `.url` / `.reg` / `.iso` / `.vhd` / `.vhdx` / `.docm` / `.xlsm` / `.pptm` / `.svg`，阻断「AI 在工作区写入恶意文件 → 用户打开 → 任意代码执行」链路
  - 修复 MCP stdio 客户端 Windows 下经 cmd.exe shell 启动、args 可被二次解释：改 `shell: false` 直连 spawn
  - `fs:exists` native op 增加字符串类型校验（非字符串路径不再抛 TypeError）

### Fixed
  - 修复前端 rebuild 后图标/徽标全丢（根因：`npm run build` 重新生成 dist 冲掉 patch-dist.mjs 注入的 codicon `<link>`）：codicon 字体 CSS 与 theme.css 同策略改为主进程运行时注入（`insertCSS`），相对字体 URL 重写为绝对 `graycode://local/resources/codicons/...`（否则按页面路径解析 404）；注入按 key 幂等管理（reload 先移除旧样式，顺带修复规则翻倍累积）
  - 修复 `workspace.fs.delete` 忽略 `useTrash` 导致永久删除：`useTrash: true` 时走 `shell.trashItem` 进回收站，与 VS Code 语义一致
  - 修复 applyEdit 对已删除文件静默重建残缺文件：ENOENT 明确报错
  - 修复 documentCache 无界增长（长会话 GB 级膨胀）：100 条 LRU 上限
  - 修复 overlay toast 超时自动移除但从不回执：移除前发送 `host.toastReply { id, selected: undefined }`，后端 `showMessage` Promise 不再永久挂起
  - 修复后端初始化失败静默白屏 + unhandled rejection：弹原生错误对话框（可打开数据目录或退出）
  - 修复 `will-navigate` 前缀校验过宽（`graycode://evil/` 等 host 变体）：严格限定 `graycode://local/`

### Added
  - 代码查看面板与变更查看面板的基础语法检查能力（引擎/入口与主项目同步，详见根 `CHANGELOG.md` [1.5.0]）

## [1.4.0] - 2026-08-04

### Fixed
  - 修复存在最近对话栏（欢迎面板历史列表）时无法发送消息：渠道只配置了 `models` 列表而未显式选择 `model` 时（`model` 为空字符串），前端 `currentModel` 为空导致发送按钮被禁用、消息永远发不出去；现在 `ConfigManager` 创建/更新/读取三个路径统一回退到 `models[0]`（读取路径只作用于副本不污染缓存，更新路径自动修复历史坏数据），前端 `loadCurrentConfig` 与输入区 `currentModel` 同步兜底；新增 6 个后端回归用例 + UISMOKE `sendFromEmpty` 步骤（欢迎面板可见时输入并发送，断言用户消息卡片出现）
  - 便携式多实例：所有数据（会话/设置/工作区/记忆/用量/缓存）默认写入应用目录下 `data/`，不再写入系统路径（AppData/Program Files）——复制应用目录即得完全独立的实例，互不影响；`--user-data-dir <path>` / `GRAYCODE_USER_DATA_DIR` 仍可显式覆盖

### Added
  - 变更查看面板（Diff Viewer）：由全屏模态框改为**主窗口内嵌 GitHub 风格面板**（右侧抽屉，非独立窗口，运行逻辑与 SubAgent Monitor 内嵌面板一致）。`vscode.diff` 拦截 → `host.openDiffPreview` 命令 → 打开面板：左侧文件列表（状态徽标 + ±行数统计），右侧统一 diff（hunk 头 `@@ -a,b +c,d @@` + 双行号 + 增删着色），支持单文件/全部接受与拒绝、删除警戒提示、`diff.statusChanged` 状态同步；accept/reject 复用 VS Code 版同一协议（`electron-app/renderer/overlay.js` 的模态框已移除）
  - 行级 diff 算法抽取为公共工具 `frontend/src/utils/diffLines.ts`（LCS 行匹配 + hunk 分组 + 统计），write_file 工具卡改用它，删除重复实现；配套 Vitest 12 例
  - UISMOKE 新增 `diffPanel` 步骤：命令打开面板 → 断言文件列表/增删行/hunk 头 → 关闭按钮收起（防回归）
  - 新增快速启动脚本：`start.bat`（Windows）/ `start.sh`（macOS/Linux）——按需安装依赖并增量构建，双击或一条命令即可启动；`--rebuild` 参数强制全量重建
  - 子代理 Monitor 改为主窗口内嵌面板（右侧分区，替代独立 BrowserWindow）：不再占用任务栏；顶部栏新增 Monitor 开关按钮，工具卡「打开详情」直接聚焦对应 run；面板可折叠，折叠时后端自动停止推送高频流式事件（llm_delta 50ms 合并节流，重新打开按 revision 校准）
  - 顶部栏常驻化：无标签页时显示 GrayCode 占位标题，右侧固定「SubAgent Monitor 开关 / 语言切换 / 设置齿轮」，语言在 简体中文 → English → 日本語 → Auto（跟随系统）间循环并持久化
  - 日文语言包接入全部工具卡/终端组件（旧 i18n 链路补齐 ja 与 auto 解析）；「跟随系统」模式接线系统语言检测
  - 首次运行引导（Welcome / 配置 API 渠道）只显示一次：已显示过或已配置真实 Key 后不再弹出（持久化标记）

### Fixed
  - 修复设置齿轮与语言切换按钮缺失（多次回归根因：顶部栏被回退为上游版本）；改为常驻渲染后 UI 冒烟测试稳定
  - 修复 `showQuickPick` 丢弃 options 且 `canPickMany` 返回形状错误（Diff 多块选择 `selected.some is not a function` 崩溃）：options 转发渲染层，多选返回数组
  - 修复后端自动打开的 Diff 预览左栏恒空：`vscode.diff` 的 `gemini-diff-original:` 分支经 `resolveOriginalContent` 从 DiffManager 实况补取原始内容
  - 修复 glob 花括号 `{a,b}` 永不匹配（`find_files` 的 exclude 规则全部失效）；重构为未锚定正则拼接
  - 修复 `findFiles` 并发遍历饿死深层目录与多工作区同相对路径互相吞结果：8 路并发 + 空队列不推进游标 + 去重键改绝对路径
  - `workspace.fs.readFile` 改为零拷贝 Buffer 视图，大文件读取不再产生整份复制

## [1.3.1] - 2026-08-03

### Added
  - Electron 独立桌面版首版：完整复用 GrayCode v1.3.1 后端（渠道/对话/工具/diff/MCP/子代理/检查点/记忆/技能/用量）与 Vue3 前端，脱离 VS Code 运行
  - `vscode` API 兼容层（`vscode-shim.ts`）：Uri / workspace.fs / 配置 / 对话框 / diff 命令 / findFiles / openTextDocument / 主题等，esbuild alias 内联进主进程 bundle
  - `graycode://` 自定义协议服务前端与资源（MIME 表 + mtime 内存缓存），规避 `file://` 的 fetch/audio CORS 限制
  - Diff 预览模态框（接受/拒绝/逐块），`vscode.diff` 命令拦截 + sessionId 异步解析（3s 轮询兜底）
  - Overlay：toast / quickPick / inputBox / 无工作区提示 / 首次运行 Welcome（DOM-ready 守卫）
  - 多语言 UI（简体中文 / English / 日本語）+ 顶部栏新建标签 / 语言切换 / 设置齿轮
  - 首次运行引导与无工作区提示；工作区选择与持久化、失效目录自动降级提示
  - 子代理 Monitor 独立窗口版（后续版本已改为内嵌面板）；run 卡片「继续」按钮与前后台任务状态回流
  - 打包：electron-builder（win NSIS/zip、mac dmg/zip、linux AppImage/deb）+ GitHub Actions 三平台 CI
  - 测试体系：后端 E2E（7 场景 40+ 断言）、UI 冒烟（UISMOKE）、MONITOR_SMOKE、mock MCP 服务器

### Fixed
  - 修复「无法打开项目文件夹」：WorkspaceFolder 补 `fsPath` 字段 + `Uri.toString()` 输出标准 `file:///` 格式
  - 修复 macOS activate 重复注册 IPC 导致消息执行两次
  - 修复 overlay.js 在 body 就绪前执行导致 appendChild 报错（DOM-ready 守卫）
  - 修复自定义协议 MIME 缺失/大小写敏感路径校验（Windows 路径归一化）
  - 修复 diff 预览右栏恒空与 sessionId 失效（两种 diff 路径分别处理）
  - 修复 findFiles 默认跳过 dist/build 导致 AI 无法检查构建产物（改为设置可覆盖）
  - 修复 workspaceState/globalState 导出 null（JSON 文件持久化）
  - 修复 `require('./vscode-shim')` 打包后必崩（改为具名导入）
