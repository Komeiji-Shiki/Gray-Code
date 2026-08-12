# GrayCode

<p align="center">
  <img src="https://raw.githubusercontent.com/Komeiji-Shiki/GrayWill-ST/main/picture/2.png" alt="GrayCode" width="480" />
</p>

<p align="center">
  <strong>一个面向 VS Code 的 AI 编程助手扩展</strong>
</p>

<p align="center">
  多模型渠道 · 工具调用 · MCP · 设计/计划/审查工作流 · 永久记忆 · 多模态上下文
</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/stargazers"><img src="https://img.shields.io/github/stars/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="https://github.com/Komeiji-Shiki/Gray-Code/releases"><img src="https://img.shields.io/github/v/release/Komeiji-Shiki/Gray-Code?style=flat-square&logo=github" alt="Latest Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Komeiji-Shiki/Gray-Code?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.84.0-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white" alt="VS Code ^1.84.0" />
</p>

---

## 目录

- [更新日志](CHANGELOG.md)
- [关于 GrayCode](#关于-graycode)
- [快速开始](#快速开始)
- [核心能力](#核心能力)
- [模型渠道配置](#模型渠道配置)
- [常用工作流](#常用工作流)
- [内置工具一览](#内置工具一览)
- [设置页面说明](#设置页面说明)
- [上下文与提示词](#上下文与提示词)
- [MCP Skills and Sub-Agents](#mcp-skills-and-sub-agents)
- [数据存储与同步](#数据存储与同步)
- [安装与更新](#安装与更新)
- [本地开发](#本地开发)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [衍生项目](#衍生项目)
- [鸣谢](#鸣谢)
- [许可证](#许可证)

---

## 关于 GrayCode

GrayCode 是运行在 VS Code 里的 AI 编程助手，它能在聊天中理解你当前的工作区，读取和修改文件，搜索代码，执行命令，查看符号引用，管理任务计划，也可以通过 MCP 接入外部工具。它适合让 AI 帮你阅读陌生项目、解释模块关系、定位 Bug，或者直接改代码并通过 VS Code Diff 预览后再接受或拒绝。你可以把需求先沉淀为设计文档，再生成执行计划，最后按计划实现，也可以对已有改动进行 Review 并生成结构化审查记录。在长对话中它可以按设置自动总结上下文，降低重复解释成本。通过 MCP、Skills、Sub-Agents 可以扩展专用能力，而永久记忆功能让 AI 跨会话记住项目约定、设计决策和个人偏好，并默认在新会话中进行记忆唤起。

## 快速开始

1. **安装扩展** —— GrayCode 已上架 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode)，可直接在扩展视图搜索 "Gray Code" 安装；也可以通过 VSIX 文件安装：
   - 前往 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 下载对应版本的 `graycode-*.vsix` 文件（也可以在本地自行打包，方法见「安装与更新」）。
   - 打开 VS Code，按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`）打开命令面板，执行 `Extensions: Install from VSIX...`，在文件选择框中选中下载的 VSIX 文件，等待安装完成。
   - 也可以点击左侧活动栏的扩展图标（快捷键 `Ctrl+Shift+X`），在扩展视图右上角的 `...` 菜单中选择 `Install from VSIX...`，再选择 VSIX 文件。
   - 安装完成后在扩展列表中找到 GrayCode 并确认已启用。
2. **打开聊天面板** —— 点击 VS Code 左侧活动栏的 Gray Code 图标，或在命令面板执行 `GrayCode: 打开聊天面板`。
3. **新建并配置渠道** —— 打开聊天面板右上角设置 → 渠道，点击新建渠道，选择渠道类型（Gemini、OpenAI Compatible、OpenAI Responses 或 Anthropic），填写 API URL 和 API Key，添加或拉取模型列表，选择默认模型。流式输出、工具模式、思考配置、自动重试等高级选项按需开启。
4. **选择对话配置** —— 回到聊天页，在输入框底部选择渠道、模型、Prompt 模式（Code / Design / Plan / Ask / Review）。
5. **开始对话** —— 输入需求即可。

第一次可以试试：「请阅读这个项目的结构，告诉我主要模块分别负责什么，并给出上手建议」，或者「请帮我定位为什么某个功能异常。先搜索相关代码，分析原因，确认方案后再修改」。

## 核心能力

**多渠道模型支持** —— GrayCode 支持 Gemini（Google Gemini API 及兼容格式服务，支持原生 Function Calling、多模态、思考配置、图片数量上限等）、OpenAI Compatible（OpenAI Chat Completions 及兼容接口，适合 OpenAI、DeepSeek、各类中转与兼容服务）、OpenAI Responses（使用 `/v1/responses` 风格接口，支持 Responses 工具调用与 token 计数）、Anthropic（Claude API，支持 Claude tool_use、扩展思考、Prompt Caching 等）。每个渠道都可以单独配置模型、API URL、API Key、工具模式、流式输出、超时、重试、自定义 Headers、自定义 Body、上下文阈值和 token 计数方式。

**工具调用与代码操作** —— AI 可以调用内置工具完成真实操作：读写文件、创建目录、删除文件，用结构化内容替换、插入/删除行、搜索替换等方式修改代码，搜索文件名和文件内容，执行终端命令并返回输出，使用 VS Code LSP 获取符号、跳转定义、查找引用，生成/处理图片，创建 Design / Plan / Review / Progress 文档，维护 TODO 列表、检索历史对话、发出 Windows 通知。设置页面中的工具名称与说明随界面语言切换（中/英/日），模型调用时仍使用 `read_file`、`apply_diff` 等固定工具名。模型传错工具参数类型时自动纠正（如字符串 `"true"` → 布尔、字符串化数组 → 数组），未知参数剥离并回传警告，不会让整次调用失败。同一批相邻且声明为只读的内置工具（如 read_file、list_files、find_files、get_symbols、goto_definition、find_references、history_search、read_skill、memory_wake、memory_recall、memory_zoom）自动并行执行，降低多次读取/搜索的累计延迟。相同参数连续失败 2 次后，第 3 次相同调用会短路返回"换个思路"提示，避免模型反复重试同一失败调用浪费迭代次数。文件工具结果中的路径可点击跳转到编辑器；点击 insert_code / delete_code 的结果路径还会定位到插入/删除行并高亮。敏感工具可以设置为"需要确认"，文件修改会尽量通过 Diff 预览，方便你检查后再接受。

**设计、计划、审查工作流** —— GrayCode 内置面向复杂任务的文档工具：Design 把需求、约束、方案、接口和风险整理到 `.graycode/design/**.md`，Plan 把已确认设计拆成可执行步骤和 TODO 写入 `.graycode/plans/**.md`，Progress 维护项目级进度台账 `.graycode/progress.md` 记录当前阶段、风险、里程碑和下一步，Review 把代码审查过程、证据、发现、结论固化到 `.graycode/review/**.md`。这套工作流适合多人协作或长周期任务：先想清楚，再执行，再检查，不容易在长对话里丢上下文。

**智能上下文** —— GrayCode 会根据设置把当前环境信息发送给模型：工作区文件树、当前打开的标签页、当前活动文件、VS Code 诊断信息、固定文件/固定目录、输入框里拖拽或引用的文件、文件夹、选中代码，以及当前时间、系统环境、工作区路径等动态信息。也支持"单次动态上下文"和"保留动态上下文"策略，适合需要跨多轮持续引用同一批文件的任务。

💡 **推荐设置：** 如果你习惯连续输入多轮（长对话、持续让 AI 改代码），可以在设置 → 提示词的模式编辑中把动态上下文策略选为「保留旧动态上下文原位」。这样有助于保持请求前缀稳定，提高 Anthropic Prompt Caching、DeepSeek KVCache 等缓存的命中率；完整原理和适用场景见下文「动态上下文策略」。

**多模态与附件** —— 输入框支持添加文件、图片、音频、视频、文档等附件。文本附件（如 txt）按 MIME 类型解码为文本块发送；PDF 在 OpenAI Responses 下转为 `input_file`、在 Anthropic 下转为 document 块；OpenAI Chat Completions 可在渠道设置中开启 `pdfAttachmentEnabled` 以文件内容块发送。`read_file` 可在支持的模型/渠道下读取图片或 PDF 等多模态文件。拖拽工作区非文本文件时，会作为附件和结构化上下文传递，而不是强行当文本解析。

**MCP 扩展** —— 支持 Model Context Protocol，可连接外部 MCP Server（stdio、sse、streamable-http）。连接后，MCP 工具可以和内置工具一起提供给模型使用。

**Skills 与 Sub-Agents** —— Skills 是用户自定义知识模块，AI 可通过 `read_skill` 按需加载专用说明、约定或领域知识。Sub-Agents 可配置专用子代理，限定工具集和提示词，让复杂任务中的某些子任务由更专门的代理完成。

**永久记忆（OptMem）** —— GrayCode 内置了 OptMem 永久记忆系统，让 AI 跨会话记住重要信息。默认提示词会要求 AI 在每次新会话开始时先调用 `memory_wake` 恢复之前的约定、决策和知识，并在工作中通过 `memory_note` 记录值得长期保留的信息，例如项目约定、用户教授的知识和关键决策。旧记忆通过二叉树结构压缩为一行摘要，减少 token 占用并尽量保留重要信息。支持 `memory_recall` 正则搜索全部记忆、`memory_zoom` 展开树节点逐层查看。记忆数据以追加式日志 + 固定宽度记录存储，不依赖任何外部服务，完全本地化。可在设置 → 记忆中自定义记忆系统的使用提示词，或通过 `{{$MEMORY}}` 模板变量精细控制；实际调用行为也受工具启用状态、Prompt 模式和模型工具调用能力影响。可在设置 → 记忆中直接查看并原地编辑所有原始记忆条目（Raw Memory Entries），编辑后自动清理相关树摘要；也可在设置页手动添加新记忆（等价 `memory_note`）或单条删除记忆（删除后条目重编号，相关摘要自动清空）。可在设置 → 记忆中调整记忆运行时参数：wakeLines（唤醒输出行数）、entryChars（单条记忆最大字节）、partChars（分页最大字符数）、partLines（分页最大行数）。Sub-Agent 模式下自动禁用记忆工具，避免子代理写入重复或错误的记忆。

**对话与体验** —— 多对话标签页，支持同时保留多个工作现场。对话历史自动保存，可查看、恢复、迁移旧历史。消息队列让 AI 忙碌时可以继续输入，后续自动排队——排队消息在 LLM 执行完当前动作后即自动发出，无需等待整轮结束；后台子代理 / 后台命令完成时回执同样「完成即插入」，不再硬等模型回合结束（主会话工具循环/流式中直接发消息会插入当前回合立即投递）。工具执行状态、token 使用、思考内容、响应耗时等信息可视化。自动存档点可按策略为关键消息或工具执行创建恢复点。声音提醒和 Windows 通知适合长时间任务完成或等待确认时提醒你。中英日文界面与外观设置。用量统计页面从对话历史回溯聚合 token 用量，支持总览 + 按对话/按模型/按日期三个维度，含条形图可视化、缓存写入/命中与成本估算，支持时间范围筛选。Mermaid 图表渲染让 Markdown 代码块中的 Mermaid 语法自动渲染为流程图、时序图等图表。

**流式渲染体验** —— AI 输出经过精细的流式渲染：平滑输出以自适应速率匀速放字（积压多自动加速、供应商卡顿时打字渐缓而非冻结，外观设置可调档位：直通 / 灵敏 / 标准 / 丝滑），字符级淡入流水线让高生成速度下呈现连绵字符流，已完成段落即时渲染 Markdown 格式（列表/代码块不再等整段输出结束）；流式期间长代码块自然展开方便跟随阅读，结束后保留展开态不塌缩。输入区底部 TPS 实时可视化条显示当前生成速度曲线（EMA 平滑、可关闭）。启动时开屏动画以描线动画绘制 Gray logo（可关闭）。

**使用时间统计** —— GrayCode 自动统计你的 IDE 活跃时间：以 60 秒心跳 + 用户活动事件（编辑、光标、滚动、切换编辑器、终端、窗口聚焦）采集活跃状态，连续 5 分钟无活动自动暂停；AI 工作期间（模型流式生成、工具执行、子代理生成、后台任务）同样记为活跃。用量统计页与设置 → 用量统计中的「使用时间」区块展示今日已用、当前连续工作时长与范围内合计，近 7/30 天的每日使用时长条形图，90 天及以上的按月聚合（点击月份展开每日明细），以及最近 7 天 × 24 小时作息热力网格（悬停查看该小时活跃分钟数），范围支持近 7 天 / 30 天 / 90 天 / 1 年 / 全部。AI 也可通过 `get_activity_stats` 工具查询你的使用时间统计，用于了解工作休息节奏。统计仅含时间戳、完全本地存储，不含对话内容。

**树状分支对话** —— 重新生成（reroll）与编辑用户消息不再破坏历史：旧回答保留为候选分支，同一父节点下可管理多个候选（上限 10 个），支持左右切换候选并重建当前活跃路径，每个候选可继续向下对话形成独立子分支；消息区顶部的候选切换器（‹ 2/3 ›）与完整分支树面板可查看/切换/重命名/软删除分支（软删可恢复，保留期默认 30 天，设置页可一键清理）。分支树面板提供「分支导航 / 完整消息」双模式：导航模式折叠连续线性消息只保留分支点，完整模式为轨道式泳道布局可查看全部节点。编辑用户消息时可选「保持当前分支」原地保存——只改写目标消息文本，后续消息、检查点与分支全部保留，不重新生成。分支切换默认仅切聊天，检测到分支执行过写工具或持有工作区存档时提示是否连同工作区存档一起恢复（恢复前统一拦截未保存文件并确认，不再静默丢弃未保存内容）；存档与分支节点双向关联（工具执行自动绑定），分支删除时按引用计数清理不再使用的存档。用量统计包含全部分支（非活跃候选的消耗也计入）。

**子代理（Sub-Agents）** —— 可配置专用子代理限定工具集与提示词；子代理支持嵌套（子代理可再派生子代理，深度上限 2，权限继承父级）；支持前台/后台两种模式，后台子代理通过任务栏查看与取消，完成后的回流卡片支持默认折叠 / 中展开 / 完全展开三段式视图；用户发送新消息时前台子代理自动转为后台继续运行而不会被中断；子代理之间及与主对话之间可通过 `agent_send_message` 互相通信（信箱机制，随最近一次工具调用结果注入）。子代理设置可配置默认迭代次数与运行时间上限（单代理可覆盖全局默认）。

## 模型渠道配置

所有渠道都支持或部分支持 API URL / API Key、模型列表（可手动添加或从服务端拉取）、工具模式（function_call 使用原生工具调用能力，xml 把工具说明注入为 XML 格式适合不稳定或不支持原生工具的模型，json 把工具说明注入为 JSON 代码块格式）、preferStream / stream 控制是否优先流式输出、timeout 请求超时时间、自动重试（失败后重试次数和间隔）、自定义 Headers（给中转站或自建服务添加额外请求头）、自定义 Body（追加或覆盖请求体字段，支持简单键值和完整 JSON）、上下文阈值（到达一定 token 占比后裁剪或总结上下文）、strict tools（在支持的渠道上让工具参数更严格地遵守 schema）、Token 计数方式（可使用渠道默认方式、Gemini countTokens API、自定义 OpenAI 格式计数 API、OpenAI Responses、Anthropic count_tokens 或本地估算）。

**Gemini** 常用配置包括 API URL（默认可使用 Gemini API 地址）、API Key（可选择是否使用 `Authorization: Bearer`）、temperature、maxOutputTokens、思考配置（默认、按等级、按预算）、是否返回思考内容、历史图片数量上限避免多模态历史过大。

**OpenAI Compatible** 适用于 OpenAI Chat Completions 以及兼容服务，例如部分第三方中转、自建网关或兼容 OpenAI 格式的模型服务。常用配置包括 temperature、max_tokens、top_p、frequency_penalty、presence_penalty、Reasoning 参数（如 effort、summary）、自定义 Headers / Body 适配中转站特殊参数、DeepSeek `user_id` 开关（启用后基于对话 ID 生成稳定标识用于 DeepSeek KVCache 按对话隔离；默认关闭避免误判中转或其他兼容服务）。

**OpenAI Responses** 适用于 Responses API，它和 Chat Completions 的主要差异是使用 input、instructions 和 output 风格结构。常用配置包括 API URL（通常填写基础地址，不必手动拼完整 `/responses`）、max_output_tokens、top_p、temperature、Reasoning 参数、Responses token 计数。

**Anthropic** 适用于 Claude API。常用配置包括 API URL / API Key、可选择是否使用 `Authorization: Bearer` 替代默认 key header、temperature、max_tokens、top_p、top_k、扩展思考（enabled、adaptive、disabled）、Prompt Caching（用于降低长上下文成本和延迟，支持缓存 TTL 选择 5 分钟 / 1 小时和缓存保活开关）、思考内容显示模式（隐藏/摘要，控制 API 响应中是否返回可见的思考内容，Opus 4.7+）、思考努力级别（支持 low / medium / high / xhigh / max 五档）。

## 常用工作流

**让 AI 改代码** —— 用自然语言描述要改的功能或 Bug，让 AI 先阅读相关文件并说明修改方案，AI 调用文件工具生成 Diff，在 VS Code Diff 视图检查修改，点击接受或拒绝变更，让 AI 执行测试或你自己执行验证。建议提示：「先定位相关代码并说明方案，等我确认后再修改。修改后运行相关测试」。

**复杂需求：Design → Plan → Implement** —— 适合较大的功能改动。切到 Design 模式让 AI 生成设计文档，确认设计后切到 Plan 模式让 AI 生成实施计划和 TODO，回到 Code 模式按计划逐项实现，实现过程中让 Progress 记录里程碑和风险，最后切到 Review 模式做审查。推荐提示：「请先为这个需求创建 design 文档，不要直接写代码。需要列出范围、方案、影响面、风险和验收标准」。

**只问问题不改代码** —— 切换到 Ask 模式，或直接说明：「只分析和解释，不要修改任何文件，也不要执行命令」。

**审查已有改动** —— 切换到 Review 模式：「请审查当前工作区改动，重点看正确性、边界情况、测试覆盖和可维护性，输出结构化 review 文档」。

**长对话续航** —— 当上下文变长时可以开启自动总结，手动让 AI 总结当前上下文，使用 Plan / Progress 文档保存任务状态，使用"保留动态上下文"发送让关键上下文跨回合固定。

## 内置工具一览

工具是否可用取决于设置开关、依赖状态、当前渠道能力和工作区权限策略。

| 分类 | 工具 | 说明 |
| --- | --- | --- |
| 文件工具 | read_file、write_file、list_files、delete_file、create_directory、apply_diff、insert_code、delete_code | 读取（单文件 `path` / 批量 `files`，可分别指定行范围，多模态下可读图片/PDF）、写入、目录管理、结构化替换与插入/删除行；修改会展示 Diff 预览 |
| 搜索工具 | find_files、search_in_files | glob 搜索文件路径；搜索或替换文件内容，支持正则与上下文预览 |
| 终端工具 | execute_command | 执行 shell 命令（PowerShell、CMD、Bash、Git Bash、WSL 等） |
| LSP 代码智能 | get_symbols、goto_definition、find_references | 获取符号结构、跳转并读取符号定义、查找符号引用 |
| 媒体工具 | generate_image、remove_background、crop_image、resize_image、rotate_image | 生成图片、移除背景、裁剪、缩放、旋转 |
| 任务与文档 | todo_write、todo_update、create_design / update_design、create_plan / update_plan、create_progress / update_progress、record_progress_milestone、validate_progress_document、create_review、record_review_milestone、finalize_review、validate_review_document、reopen_review、compare_review_documents | TODO 列表与设计 / 计划 / 进度 / 审查文档的创建、更新、校验与对比 |
| 子代理 | subagents | 委派任务给专用子代理：前台等待、后台运行、`continueFromRunId` 接续；子代理不含永久记忆工具，过程可在 SubAgent Monitor 查看 |
| 历史 / 技能 / 通知 | history_search、read_skill、show_windows_notification | 检索对话历史、读取 Skill 内容、Windows 系统通知 |
| 使用时间 | get_activity_stats | 查询用户 IDE 使用时间统计（每日使用时长、最近作息热力、连续工作时长），数据仅含时间戳 |
| 记忆 | memory_wake、memory_note、memory_recall、memory_compress、memory_zoom、memory_forget、memory_config | OptMem 永久记忆：唤醒、记录、正则搜索、压缩合并、树节点展开、丢弃摘要或删除单条/闭区间原始记忆、参数管理 |

## 设置页面说明

点击聊天面板右上角设置按钮可以看到渠道（管理模型渠道、模型列表、API 参数、工具模式、重试、自定义 Headers/Body 等）、工具（启用/禁用工具，调整工具配置，设置单回合最大工具调用次数）、自动执行（控制哪些工具可自动执行，哪些必须人工确认）、MCP（添加、连接、管理 MCP Server）、存档点（配置自动 checkpoint、四层排除规则与清理恢复点，支持预览排除结果）、总结（配置自动总结阈值、总结模型和总结提示词）、图像生成（配置图片生成服务和相关参数）、依赖（检查和安装部分工具依赖）、上下文（控制文件树、打开标签页、诊断、固定文件等上下文注入）、提示词（管理 Prompt 模式、传统模板、预设条目 Prompt Entries、动态上下文模板/策略、模板变量和模式级工具策略）、Token 计数（配置不同渠道的 token 计数方法）、Sub-Agents（配置专用子代理、工具范围和提示词）、声音（配置任务完成、错误、警告等提示音）、外观（配置界面语言、加载文字、开屏动画、TPS 实时可视化条、流式平滑档位、选中代码入口等 UI 偏好）、用量统计（内嵌「使用时间」区块与 Token 用量摘要卡片，含「查看完整统计」整页入口）、记忆（配置永久记忆系统 OptMem，自定义 AI 记忆使用提示词）、通用（代理、数据存储路径迁移、设置导入/导出等通用功能）。

## 上下文与提示词

**Prompt 模式** —— 默认内置五种模式：Code（日常编码、修改文件、运行测试）、Design（需求分析和方案设计，偏向先产出设计文档）、Plan（任务拆解、TODO、执行计划）、Ask（只问答、解释、分析，尽量不修改文件）、Review（审查代码和改动，产出 review 记录）。你可以在设置 → 提示词中修改、复制、删除或新增模式。每个模式都可以独立配置组装方式（传统模板或预设条目）、静态系统提示词、动态上下文模板、动态上下文保留策略、模式级工具策略（继承默认工具集，或只允许某些工具）。聊天输入框底部的模式选择器会使用这些模式；保存提示词设置后输入区会刷新模式列表。

**传统模板与预设条目** —— GrayCode 目前支持两种提示词组装方式。传统模板（Legacy）适合简单、兼容旧配置、只需要一段系统提示词和一段动态上下文的场景，template 作为系统提示词，dynamicTemplate 作为临时动态上下文消息插入请求。预设条目（Prompt Entries）适合想精确控制 system/user/assistant 上下文顺序或想指定真实聊天历史插入位置的场景，按条目顺序组装，Chat History 条目表示真实对话历史插入点。

传统模板是最容易理解的模式：系统提示词模板用于长期稳定的规则和角色说明，适合放环境说明、工具说明、总体行为规范；动态上下文模板每轮请求临时生成不写入真实聊天历史，适合放文件树、打开标签页、诊断、TODO、固定文件等会变化的信息。如果你只是想改 AI 的角色、语气或默认做事方式，使用传统模板即可。

预设条目更像一个"请求骨架编辑器"。在设置 → 提示词中把组装方式切到预设条目后可以新增、复制、删除、启用/禁用、拖拽排序条目。条目分为普通 Prompt 条目（会按所选角色发送给模型，可写内容和变量）和 Chat History 条目（固定的真实聊天历史插入点，不会作为普通消息发送，不可删除、不可禁用，但可以拖动调整位置）。普通 Prompt 条目有三种角色：system（合并进系统提示词，典型用途是全局规则、工具说明、输出格式、长期约束）、user（作为临时用户上下文插入请求不保存到真实历史，典型用途是当前任务上下文、文件树、TODO、补充材料）、assistant（作为临时助手消息插入请求不保存到真实历史，典型用途是少量示例回复、期望格式示例、预置中间状态）。Chat History 的位置很关键：放在所有条目后面时模型会先看预设规则和上下文再看真实历史，放在中间可以实现"历史前置上下文 → 真实历史 → 历史后置约束"，放在前面适合把一些强约束放到真实历史之后再次强调。预设条目支持从传统模板转换，适合把旧的一大段 prompt 拆成多个小块后续更容易维护。

**动态上下文策略** —— 动态上下文是"每次请求临时生成的上下文"，例如文件树、打开标签页、当前活动文件、诊断、TODO、固定文件等，它通常不会写入真实对话历史避免历史越来越脏。GrayCode 支持两种动态上下文保留策略：single（每轮只插入当前最新的一份动态上下文；旧回合的动态上下文不会固定回放，适合大多数普通聊天避免重复上下文占 token）、preserve（保留每个回合缓存过的动态上下文并尽量插回原来的历史位置；新回合上下文插入到新回合位置；请求前缀保持稳定有利于 LLM Prompt Cache 命中，适合多轮连续编辑同一批文件、需要模型记住每轮当时看到的上下文、用户输入次数多的长对话）。使用建议：日常问答、短任务用 single；长任务、多轮实现、审查过程中需要保持上下文位置稳定时可以用 preserve（即「保留旧动态上下文原位」）。请求前缀稳定后有助于提高 Anthropic Prompt Caching、DeepSeek KVCache 等缓存的命中率，并可能降低后续请求的延迟和成本，实际收益取决于模型服务及请求内容。preserve 会增加历史 token 压力，如果发现上下文过长可以切回 single 或开启自动总结。动态上下文策略可以在提示词模式里配置；输入区也提供「发送并保留旧动态上下文原位」入口用于临时覆盖本次发送策略。

**上下文感知设置** —— 设置 → 上下文控制"哪些信息可以成为动态上下文"：是否发送工作区文件树、文件树最大深度、是否发送打开的标签页列表、打开标签页最大数量、是否发送当前活动编辑器路径、是否发送 VS Code 诊断以及诊断严重程度和数量限制、自定义忽略模式避免把 node_modules、日志、构建产物等塞进上下文。这些开关决定变量能不能生成内容；提示词模板或预设条目里是否引用变量则决定这些内容最终会不会被放进请求。

**模板变量** —— 系统提示词、动态上下文模板和预设条目内容都支持 `{{$变量名}}` 形式的变量。常用静态变量包括 `{{$ENVIRONMENT}}`（工作区路径、操作系统、时区、用户语言等环境信息）、`{{$CONTEXT_BADGE_FORMAT}}`（输入框上下文徽章的格式说明，告诉模型 title、body、binary 标记分别代表什么）、`{{$TOOLS}}`（内置工具说明，按当前渠道工具模式生成）、`{{$MCP_TOOLS}}`（已连接 MCP Server 暴露的工具说明）、`{{$MEMORY}}`（永久记忆系统的使用提示词）。常用动态变量包括 `{{$TODO_LIST}}`（当前会话 TODO 状态）、`{{$WORKSPACE_FILES}}`（工作区文件树）、`{{$OPEN_TABS}}`（当前打开的编辑器标签页）、`{{$ACTIVE_EDITOR}}`（当前活动编辑器路径）、`{{$DIAGNOSTICS}}`（VS Code 诊断信息）、`{{$PINNED_FILES}}`（固定文件内容）、`{{$SKILLS}}`（当前启用的 Skills 摘要或内容）。在预设条目编辑器中可以直接点击"插入变量"把变量追加到当前条目。如果你升级后发现上下文说明异常，建议在提示词设置中恢复默认模板再按需要二次修改。

**固定文件和上下文徽章** —— 输入区支持添加上下文徽章：文件或目录、当前编辑器选区、附件、固定文件、Skill。这样可以明确告诉模型"这轮要重点看什么"。

## MCP Skills and Sub-Agents

**MCP** —— 在设置 → MCP 中添加服务器：stdio（填写命令、参数和环境变量）、sse（填写 SSE URL 和请求头）、streamable-http（填写 HTTP URL 和请求头）。连接成功后服务端暴露的工具会进入模型可用工具集合。某些模型对 JSON Schema 字段较挑剔，可以开启 schema 清理。

**Skills** —— Skills 是可复用知识模块，适合放项目约定、Commit 规范、常用排查手册、特定框架或业务知识。启用后 AI 会看到可用 Skill 列表，并可用 `read_skill` 按需读取完整内容。

**Sub-Agents** —— Sub-Agents 适合把任务拆给"专门角色"，例如测试分析代理、文档整理代理、安全审查代理、前端样式代理。每个子代理可以设置自己的提示词和允许使用的工具范围；为避免子代理重复或错误地改写跨会话数据，永久记忆工具不会进入子代理可用工具列表。主模型调用子代理时可传入 `continueFromRunId` 将新任务接续到之前已完成的子代理对话上，实现跨调用的对话接力；目标 run 不存在或仍在运行时会拒绝接续。

**SubAgent Monitor** —— GrayCode 提供独立的 SubAgent Monitor 面板用于实时查看和管理子代理运行状态：多 run 标签页可同时监控多个子代理，实时输出自动跟随贴底时随内容增长自动滚动，暂停/继续/退出控制可中途干预子代理执行，历史 run 只读回看（已完成或已取消的 run 标记为「历史运行 · 仅可查看」），「加载更早消息」支持翻看完整 transcript，后台派发的子代理完成后以紧凑卡片回流到主聊天内联结果正文并支持跳转 Monitor 查看完整记录。

## 数据存储与同步

**VS Code Settings Sync** —— 大部分设置已经迁移到 VS Code Settings 的 `graycode.*` 命名空间，因此开启 VS Code Settings Sync 后可自动同步到其他设备，包括工具开关、工具自动执行策略、提示词配置、UI 偏好、Token 计数配置、图像工具配置。以下设置是机器级别不参与同步：`graycode.proxy`、`graycode.storagePath`、`graycode.activeChannelId`，这样可以避免不同机器之间代理端口、存储路径和当前渠道互相覆盖。

**自定义存储路径** —— 在设置 → 通用中可以配置数据存储路径并迁移数据。迁移后需要重新加载窗口生效。

**旧版本迁移** —— 从旧版本升级时 GrayCode 会尝试把旧的 `globalStorage/settings/settings.json` 迁移到 VS Code Settings，并备份旧文件为 `settings.json.bak`。

**设置导入/导出** —— 在设置 → 通用中可以将渠道配置、MCP 服务器、Skills 和 VSCode 设置导出为 JSON 文件或从文件导入恢复。支持跳过已存在项和覆盖全部两种导入模式。设置导出不包含对话历史、存档点、永久记忆原始数据和工作区文件；这些数据需要通过存储路径迁移或单独备份。也可通过命令面板执行 `GrayCode: 导出设置` / `GrayCode: 导入设置`。

## 安装与更新

要求 VS Code `^1.84.0` 或更高版本。源码构建和 VSIX 打包建议使用 Node.js 20 或更高版本。本扩展已上架 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=Komeiji-Shiki.graycode)，也可通过 VSIX 或源码方式安装。

**从 VSIX 安装** —— 可以前往 [GitHub Releases](https://github.com/Komeiji-Shiki/Gray-Code/releases) 获取对应版本的 `graycode-*.vsix` 文件，也可以在本地自行打包。在 VS Code 中打开命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`），执行 `Extensions: Install from VSIX...`，选择下载的 VSIX 文件。

**从源码构建并安装** —— 当前仓库使用并提交 `package-lock.json`，统一使用 npm：

```bash
# 克隆仓库
git clone https://github.com/Komeiji-Shiki/Gray-Code.git
cd Gray-Code

# 安装根目录依赖
npm ci

# 安装前端依赖
npm --prefix frontend ci

# 完整构建
npm run build

# 打包 VSIX
npx @vscode/vsce package
```

## 本地开发

**推荐：VS Code 调试配置** —— 打开本仓库后在 VS Code 的 Run and Debug 中选择 `Run Extension (Local Vite Dev)`。它会启动后端 esbuild watch 自动重新打包，启动前端 Vite Dev Server 固定端口 5173，通过 `GRAYCODE_WEBVIEW_DEV_SERVER_URL=http://127.0.0.1:5173` 让 Webview 加载本地前端资源。Vite Dev Server 只在扩展开发模式下生效；生产构建仍使用 `frontend/dist`。

**手动启动** —— 终端 A 运行 `npm run watch`（后端 watch），终端 B 运行 `npm run dev:frontend`（前端 Vite dev server），然后使用普通 `Run Extension` 或自定义带 `GRAYCODE_WEBVIEW_DEV_SERVER_URL` 的调试配置。

**常用脚本** —— `npm run compile`（通过 esbuild 打包扩展后端）、`npm run typecheck`（执行后端和扩展 TypeScript 类型检查）、`npm run watch`（esbuild watch 模式自动重新打包）、`npm run build:frontend`（构建前端 Webview）、`npm run dev:frontend`（启动前端本地开发服务器）、`npm run build`（依次构建扩展后端和前端 Webview）、`npm test`（运行后端 Jest 测试）、`npm run test:frontend`（运行前端 Vitest 测试）、`npm run test:coverage`（运行后端测试并生成覆盖率）。

## 项目结构

```text
Gray-Code/
├── backend/                 # 扩展后端能力
│   ├── __tests__/           # 后端 Jest 回归测试
│   ├── core/                # 核心上下文、日志等
│   ├── modules/             # 渠道、配置、会话、MCP、提示词、设置等模块
│   └── tools/               # 内置工具实现
├── frontend/                # Vue 3 + Pinia + Vite Webview 前端
│   ├── src/__tests__/       # 前端 Vitest 测试
│   ├── src/components/      # 聊天、输入区、设置页等组件
│   ├── src/stores/          # 状态管理
│   └── src/services/        # 前端服务
├── test/                    # 跨模块与前端工具函数测试
├── webview/                 # VS Code Webview 消息路由和处理器
├── resources/               # 图标、字体、音效等资源
├── fast-tavern-main/        # 附带的 Fast Tavern 相关子项目
├── extension.ts             # VS Code 扩展入口
├── index.ts                 # 后端模块导出入口
├── package.json             # 扩展清单、命令、配置和脚本
├── README.md                # 中文文档
└── README_EN.md             # English documentation
```

## 常见问题

**为什么 AI 没有调用工具？** 可以检查当前渠道是否启用了工具，工具模式是否适合当前模型（原生不稳定时可尝试 xml 或 json），设置 → 工具中该工具是否启用，工具是否缺少依赖，当前 Prompt 模式是否限制了工具策略。

**为什么工具执行前需要确认？** 在设置 → 自动执行中可以控制每个工具是否自动执行。删除文件、执行命令、写入工作区外路径等敏感操作建议保留确认。

**为什么读取工作区外文件失败？** read_file / write_file 对工作区外路径有独立访问策略。到设置 → 工具中展开对应工具，修改工作区外访问策略。

**read_file 如何一次读取多个文件？** 读取单个文件时继续使用 `path`、`startLine`、`endLine`；批量读取时使用 `files: [{ path, startLine?, endLine? }]`，每个文本文件可以指定不同的行范围。`path` 和 `files` 不要在同一次调用中混用。

**为什么模型上下文太长？** 可以开启自动总结，调低上下文阈值，减少文件树、打开标签页、诊断等动态上下文，减少固定文件数量，对 Gemini 多模态历史设置图片数量上限。

**修改后在哪里接受 Diff？** 当工具生成文件修改时 VS Code 会打开 Diff 预览。编辑器标题区域和快捷键可用于接受/拒绝：接受当前块（`Ctrl+Shift+Y` / macOS `Cmd+Shift+Y`）、拒绝当前块（`Ctrl+Shift+N` / macOS `Cmd+Shift+N`）、下一块（`Alt+]`）、上一块（`Alt+[`）。也可以使用命令：`GrayCode: Accept All Changes`、`GrayCode: Reject All Changes`、`GrayCode: Accept Diff Block...`、`GrayCode: Reject Diff Block...`。

**Windows 通知或声音没有出现？** 请检查设置 → 声音是否启用对应事件，Windows 系统通知是否允许 VS Code 发送通知，Webview 是否已经被浏览器策略解锁音频播放。

## 贡献

欢迎通过 [Issues](https://github.com/Komeiji-Shiki/Gray-Code/issues) 提交问题，也欢迎提交 Pull Request。建议在提交前运行 `npm run typecheck`、`npm run build`、`npm test`、`npm run test:frontend`，确保类型检查、后端与前端构建、两套测试都通过。如果改动涉及前端交互，也建议确认 Webview 本地开发模式正常。

## 衍生项目

社区基于本仓库维护的衍生项目：

- [**GrayCode Desktop**](https://github.com/czocelot/Gray-Code-Desktop) —— 独立桌面版（Electron），无需安装 VS Code，内置 `vscode-shim` 兼容层，功能与扩展版一致，支持 Windows / macOS / Linux，提供安装版与免安装便携版（[Releases](https://github.com/czocelot/Gray-Code-Desktop/releases)）。桌面版与本仓库共享同一套 backend / frontend / webview 代码，并由社区成员持续同步上游更新。

> 衍生项目由社区独立维护，其发布节奏与功能可能与本仓库不完全一致，具体以对应仓库为准。

## 鸣谢

感谢以下朋友对 GrayCode 的帮助与支持：

- [**1b0t3**](https://github.com/1b0t3) —— opencode GO 套餐及 GPT 5.6 sol 以及项目小图标logo
- [**czocelot**](https://github.com/czocelot) —— DeepSeek V4 Flash，以及 bug 寻找、项目测试与修复；并二创了 [Gray-Code-Desktop](https://github.com/czocelot/Gray-Code-Desktop)
- [**NebulaRaven**](https://github.com/NebulaRaven) —— bug 寻找、项目测试与修复 以及帮助合并pr

## 许可证

本项目采用 [MIT License](LICENSE)。