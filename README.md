# LimCode

<p align="center">
  <a href="https://discord.gg/FJxTrsZRPQ">
    <img src="https://img.shields.io/badge/Join%20in-Discord-5865F2?logo=discord&logoColor=white" alt="Join in Discord">
  </a>
</p>

<p align="center">
  <img src="resources/icon.png" alt="LimCode Logo" width="128">
</p>

<p align="center">
  <strong>一个面向 VS Code 的 AI 编程助手扩展</strong>
</p>

<p align="center">
  多模型渠道 · 工具调用 · MCP · 设计/计划/审查工作流 · 多模态上下文
</p>

---

## 目录

- [LimCode 是什么？](#limcode-是什么)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [模型渠道配置](#模型渠道配置)
- [常用工作流](#常用工作流)
- [内置工具一览](#内置工具一览)
- [设置页面说明](#设置页面说明)
- [上下文与提示词](#上下文与提示词)
- [MCP、Skills 与 Sub-Agents](#mcpskills-与-sub-agents)
- [数据存储与同步](#数据存储与同步)
- [安装与更新](#安装与更新)
- [本地开发](#本地开发)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [许可证](#许可证)

## LimCode 是什么？

LimCode 是一个运行在 VS Code 里的 AI 编程助手。它可以在聊天中理解当前工作区、读取和修改文件、搜索代码、执行命令、查看符号引用、管理任务计划，也可以通过 MCP 接入外部工具。

它适合这些场景：

- 让 AI 帮你阅读陌生项目、解释模块关系、定位 Bug。
- 让 AI 直接改代码，并通过 VS Code Diff 预览后再接受或拒绝。
- 把需求先沉淀为设计文档，再生成执行计划，最后按计划实现。
- 对已有改动进行 Review，生成结构化审查记录。
- 在长对话中自动总结上下文，降低重复解释成本。
- 通过 MCP、Skills、Sub-Agents 扩展专用能力。

## 核心能力

### 多渠道模型支持

LimCode 支持多种主流 API 格式：

| 渠道类型 | 适用场景 | 说明 |
| --- | --- | --- |
| Gemini | Google Gemini API / 兼容 Gemini 格式服务 | 支持原生 Function Calling、多模态、思考配置、图片数量上限等 |
| OpenAI Compatible | OpenAI Chat Completions 及兼容接口 | 适合 OpenAI、DeepSeek、各类中转与兼容服务 |
| OpenAI Responses | OpenAI Responses API | 使用 `/v1/responses` 风格接口，支持 Responses 工具调用与 token 计数 |
| Anthropic | Claude API | 支持 Claude tool_use、扩展思考、Prompt Caching 等 |

每个渠道都可以单独配置模型、API URL、API Key、工具模式、流式输出、超时、重试、自定义 Headers、自定义 Body、上下文阈值和 token 计数方式。

### 工具调用与代码操作

AI 可以调用内置工具完成真实操作，包括：

- 读写文件、创建目录、删除文件。
- 用统一 diff、插入/删除行、搜索替换等方式修改代码。
- 搜索文件名和文件内容。
- 执行终端命令并返回输出。
- 使用 VS Code LSP 获取符号、跳转定义、查找引用。
- 生成/处理图片。
- 创建 Design / Plan / Review / Progress 文档。
- 维护 TODO 列表、检索历史对话、发出 Windows 通知。

敏感工具可以设置为“需要确认”，文件修改会尽量通过 Diff 预览，方便你检查后再接受。

### 设计、计划、审查工作流

LimCode 内置面向复杂任务的文档工具：

- **Design**：把需求、约束、方案、接口和风险整理到 `.limcode/design/**.md`。
- **Plan**：把已确认设计拆成可执行步骤和 TODO，写入 `.limcode/plans/**.md`。
- **Progress**：维护项目级进度台账 `.limcode/progress.md`，记录当前阶段、风险、里程碑和下一步。
- **Review**：把代码审查过程、证据、发现、结论固化到 `.limcode/review/**.md`。

这套工作流适合多人协作或长周期任务：先想清楚，再执行，再检查，不容易在长对话里丢上下文。

### 智能上下文

LimCode 会根据设置把当前环境信息发送给模型：

- 工作区文件树。
- 当前打开的标签页。
- 当前活动文件。
- VS Code 诊断信息。
- 固定文件 / 固定目录。
- 输入框里拖拽或引用的文件、文件夹、选中代码。
- 当前时间、系统环境、工作区路径等动态信息。

也支持“单次动态上下文”和“保留动态上下文”策略，适合需要跨多轮持续引用同一批文件的任务。

### 多模态与附件

- 输入框支持添加文件、图片、音频、视频、文档等附件。
- `read_file` 可在支持的模型/渠道下读取图片或 PDF 等多模态文件。
- 拖拽工作区非文本文件时，会作为附件和结构化上下文传递，而不是强行当文本解析。

### MCP 扩展

支持 Model Context Protocol，可连接外部 MCP Server：

- `stdio`
- `sse`
- `streamable-http`

连接后，MCP 工具可以和内置工具一起提供给模型使用。

### Skills 与 Sub-Agents

- **Skills**：用户自定义知识模块。AI 可通过 `read_skill` 按需加载专用说明、约定或领域知识。
- **Sub-Agents**：可配置专用子代理，限定工具集和提示词，让复杂任务中的某些子任务由更专门的代理完成。

### 对话与体验

- 多对话标签页，支持同时保留多个工作现场。
- 对话历史自动保存，可查看、恢复、迁移旧历史。
- 消息队列：AI 忙碌时可以继续输入，后续自动排队。
- 工具执行状态、token 使用、思考内容、响应耗时等信息可视化。
- 自动存档点，可按策略为关键消息或工具执行创建恢复点。
- 声音提醒和 Windows 通知，适合长时间任务完成或等待确认时提醒你。
- 中英文界面与外观设置。

## 快速开始

### 1. 打开 LimCode

安装后点击 VS Code 左侧活动栏的 **Lim Code** 图标，或在命令面板执行：

```text
LimCode: 打开聊天面板
```

### 2. 新建模型渠道

进入右上角 **设置** → **渠道**：

1. 点击新建渠道。
2. 选择渠道类型：`Gemini`、`OpenAI Compatible`、`OpenAI Responses` 或 `Anthropic`。
3. 填写 API URL 和 API Key。
4. 添加或拉取模型列表。
5. 选择默认模型。
6. 根据需要开启流式输出、工具模式、思考配置、自动重试等高级选项。

### 3. 选择渠道、模型和模式

回到聊天页，在输入框底部选择：

- 渠道
- 模型
- Prompt 模式（Code / Design / Plan / Ask / Review）

然后输入需求即可开始。

### 4. 第一次可以这样试

```text
请阅读这个项目的结构，告诉我主要模块分别负责什么，并给出上手建议。
```

或者：

```text
请帮我定位为什么某个功能异常。先搜索相关代码，分析原因，确认方案后再修改。
```

## 模型渠道配置

### 通用配置

所有渠道都支持或部分支持以下配置：

- **API URL / API Key**：模型服务地址和鉴权信息。
- **模型列表**：可手动添加，也可从服务端拉取。
- **工具模式**：
  - `function_call`：使用原生工具调用能力。
  - `xml`：把工具说明注入为 XML 格式，适合不稳定或不支持原生工具的模型。
  - `json`：把工具说明注入为 JSON 代码块格式。
- **preferStream / stream**：控制是否优先流式输出。
- **timeout**：请求超时时间。
- **自动重试**：失败后重试次数和间隔。
- **自定义 Headers**：给中转站或自建服务添加额外请求头。
- **自定义 Body**：追加或覆盖请求体字段，支持简单键值和完整 JSON。
- **上下文阈值**：到达一定 token 占比后裁剪或总结上下文。
- **strict tools**：在支持的渠道上让工具参数更严格地遵守 schema。
- **Token 计数方式**：可用渠道 API、Responses `input_tokens`、Anthropic `count_tokens` 或本地估算。

### Gemini

常用配置：

- API URL，默认可使用 Gemini API 地址。
- API Key，可选择是否使用 `Authorization: Bearer`。
- `temperature`、`maxOutputTokens`。
- 思考配置：默认、按等级、按预算。
- 是否返回思考内容。
- 历史图片数量上限，避免多模态历史过大。

### OpenAI Compatible

适用于 OpenAI Chat Completions 以及兼容服务，例如部分第三方中转、自建网关或兼容 OpenAI 格式的模型服务。

常用配置：

- `temperature`、`max_tokens`、`top_p`。
- `frequency_penalty`、`presence_penalty`。
- Reasoning 参数：如 effort、summary。
- 自定义 Headers / Body，适配中转站特殊参数。

### OpenAI Responses

适用于 Responses API。它和 Chat Completions 的主要差异是使用 `input`、`instructions` 和 `output` 风格结构。

常用配置：

- API URL 通常填写基础地址，不必手动拼完整 `/responses`。
- `max_output_tokens`、`top_p`、`temperature`。
- Reasoning 参数。
- Responses token 计数。

### Anthropic

适用于 Claude API。

常用配置：

- API URL / API Key。
- 可选择是否使用 `Authorization: Bearer` 替代默认 key header。
- `temperature`、`max_tokens`、`top_p`、`top_k`。
- 扩展思考：`enabled`、`adaptive`、`disabled`。
- Prompt Caching，用于降低长上下文成本和延迟。

## 常用工作流

### 让 AI 改代码

1. 用自然语言描述要改的功能或 Bug。
2. 让 AI 先阅读相关文件并说明修改方案。
3. AI 调用文件工具生成 Diff。
4. 在 VS Code Diff 视图检查修改。
5. 点击接受或拒绝变更。
6. 让 AI 执行测试或你自己执行验证。

建议提示：

```text
先定位相关代码并说明方案，等我确认后再修改。修改后运行相关测试。
```

### 复杂需求：Design → Plan → Implement

适合较大的功能改动：

1. 切到 **Design** 模式，让 AI 生成设计文档。
2. 确认设计后切到 **Plan** 模式，让 AI 生成实施计划和 TODO。
3. 回到 **Code** 模式，按计划逐项实现。
4. 实现过程中让 Progress 记录里程碑和风险。
5. 最后切到 **Review** 模式做审查。

推荐提示：

```text
请先为这个需求创建 design 文档，不要直接写代码。需要列出范围、方案、影响面、风险和验收标准。
```

### 只问问题不改代码

切换到 **Ask** 模式，或直接说明：

```text
只分析和解释，不要修改任何文件，也不要执行命令。
```

### 审查已有改动

切换到 **Review** 模式：

```text
请审查当前工作区改动，重点看正确性、边界情况、测试覆盖和可维护性，输出结构化 review 文档。
```

### 长对话续航

当上下文变长时，可以：

- 开启自动总结。
- 手动让 AI 总结当前上下文。
- 使用 Plan / Progress 文档保存任务状态。
- 使用“保留动态上下文”发送，让关键上下文跨回合固定。

## 内置工具一览

> 工具是否可用取决于设置开关、依赖状态、当前渠道能力和工作区权限策略。

### 文件工具

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读取一个或多个文件，支持行范围；在多模态能力开启时可读取图片/PDF 等 |
| `write_file` | 写入或创建文件，并展示 Diff 预览 |
| `list_files` | 列出目录内容，可递归 |
| `delete_file` | 删除文件或目录 |
| `create_directory` | 创建目录，父目录会自动创建 |
| `apply_diff` | 应用统一 diff patch，适合精确修改 |
| `insert_code` | 在指定行前插入内容 |
| `delete_code` | 删除指定行范围 |

### 搜索工具

| 工具 | 说明 |
| --- | --- |
| `find_files` | 用 glob 搜索文件路径 |
| `search_in_files` | 搜索或替换文件内容，支持正则和上下文预览 |

### 终端工具

| 工具 | 说明 |
| --- | --- |
| `execute_command` | 执行 shell 命令，支持 PowerShell、CMD、Bash、Git Bash、WSL 等可用 shell |

### LSP 代码智能工具

| 工具 | 说明 |
| --- | --- |
| `get_symbols` | 获取文件里的类、函数、变量等符号结构 |
| `goto_definition` | 跳转并读取符号定义 |
| `find_references` | 查找符号引用 |

### 媒体工具

| 工具 | 说明 |
| --- | --- |
| `generate_image` | 调用图像生成接口生成图片 |
| `remove_background` | 移除图片背景 |
| `crop_image` | 裁剪图片 |
| `resize_image` | 调整图片尺寸 |
| `rotate_image` | 旋转图片 |

### 任务和文档工具

| 工具 | 说明 |
| --- | --- |
| `todo_write` | 初始化或替换当前对话 TODO 列表 |
| `todo_update` | 增量更新 TODO 状态或内容 |
| `create_design` / `update_design` | 创建或更新设计文档 |
| `create_plan` / `update_plan` | 创建或更新计划文档，支持 TODO 同步 |
| `create_progress` / `update_progress` | 创建或更新项目进度台账 |
| `record_progress_milestone` | 记录项目里程碑 |
| `validate_progress_document` | 校验进度文档结构 |
| `create_review` | 创建审查文档 |
| `record_review_milestone` | 记录审查阶段性结论、证据和发现 |
| `finalize_review` | 完成审查并写入最终结论 |
| `validate_review_document` | 校验审查文档结构 |
| `reopen_review` | 重新打开已完成的审查文档 |
| `compare_review_documents` | 对比两个审查文档的发现差异 |

### 历史、技能和通知工具

| 工具 | 说明 |
| --- | --- |
| `history_search` | 搜索或读取当前可访问范围内的对话历史 |
| `read_skill` | 读取已启用 Skill 的完整内容 |
| `show_windows_notification` | 在 Windows 上显示系统通知 |

## 设置页面说明

点击聊天面板右上角设置按钮，可以看到这些页面：

| 设置页 | 作用 |
| --- | --- |
| 渠道 | 管理模型渠道、模型列表、API 参数、工具模式、重试、自定义 Headers/Body 等 |
| 工具 | 启用/禁用工具，调整工具配置，设置单回合最大工具调用次数 |
| 自动执行 | 控制哪些工具可自动执行，哪些必须人工确认 |
| MCP | 添加、连接、管理 MCP Server |
| Sub-Agents | 配置专用子代理、工具范围和提示词 |
| 存档点 | 配置自动 checkpoint、查看与清理恢复点 |
| 总结 | 配置自动总结阈值、总结模型和总结提示词 |
| 图像生成 | 配置图片生成服务和相关参数 |
| 依赖 | 检查和安装部分工具依赖 |
| 上下文 | 控制文件树、打开标签页、诊断、固定文件等上下文注入 |
| 提示词 | 管理 Prompt 模式、传统模板、预设条目（Prompt Entries）、动态上下文模板/策略、模板变量和模式级工具策略 |
| Token 计数 | 配置不同渠道的 token 计数方法 |
| 声音 | 配置任务完成、错误、警告等提示音 |
| 外观 | 配置界面语言、加载文字、选中代码入口等 UI 偏好 |
| 通用 | 代理、数据存储路径迁移等通用设置 |

## 上下文与提示词

### Prompt 模式

默认内置五种模式：

| 模式 | 适用场景 |
| --- | --- |
| Code | 日常编码、修改文件、运行测试 |
| Design | 需求分析和方案设计，偏向先产出设计文档 |
| Plan | 任务拆解、TODO、执行计划 |
| Ask | 只问答、解释、分析，尽量不修改文件 |
| Review | 审查代码和改动，产出 review 记录 |

你可以在 **设置 → 提示词** 中修改、复制、删除或新增模式。每个模式都可以独立配置：

- 组装方式：传统模板或预设条目。
- 静态系统提示词。
- 动态上下文模板。
- 动态上下文保留策略。
- 模式级工具策略（继承默认工具集，或只允许某些工具）。

聊天输入框底部的模式选择器会使用这些模式；保存提示词设置后，输入区会刷新模式列表。

### 传统模板与预设条目

LimCode 目前支持两种提示词组装方式：

| 组装方式 | 适合场景 | 工作方式 |
| --- | --- | --- |
| 传统模板（Legacy） | 简单、兼容旧配置、只需要一段系统提示词和一段动态上下文 | `template` 作为系统提示词，`dynamicTemplate` 作为临时动态上下文消息插入请求 |
| 预设条目（Prompt Entries） | 想精确控制 system/user/assistant 上下文顺序，或想指定真实聊天历史插入位置 | 按条目顺序组装；`Chat History` 条目表示真实对话历史插入点 |

#### 传统模板

传统模板是最容易理解的模式：

- **系统提示词模板**：长期稳定的规则和角色说明，适合放环境说明、工具说明、总体行为规范。
- **动态上下文模板**：每轮请求临时生成，不写入真实聊天历史，适合放文件树、打开标签页、诊断、TODO、固定文件等会变化的信息。

如果你只是想改 AI 的角色、语气或默认做事方式，使用传统模板即可。

#### 预设条目（Prompt Entries）

预设条目更像一个“请求骨架编辑器”。在 **设置 → 提示词** 中把组装方式切到预设条目后，可以新增、复制、删除、启用/禁用、拖拽排序条目。

条目分为两类：

| 条目类型 | 说明 |
| --- | --- |
| 普通 Prompt 条目 | 会按所选角色发送给模型，可写内容和变量 |
| Chat History 条目 | 固定的真实聊天历史插入点，不会作为普通消息发送，不可删除、不可禁用，但可以拖动调整位置 |

普通 Prompt 条目有三种角色：

| 角色 | 发送方式 | 典型用途 |
| --- | --- | --- |
| `system` | 合并进系统提示词 | 全局规则、工具说明、输出格式、长期约束 |
| `user` | 作为临时用户上下文插入请求，不保存到真实历史 | 当前任务上下文、文件树、TODO、补充材料 |
| `assistant` | 作为临时助手消息插入请求，不保存到真实历史 | 少量示例回复、期望格式示例、预置中间状态 |

`Chat History` 的位置很关键：

- 放在所有条目后面：模型会先看预设规则和上下文，再看真实历史。
- 放在中间：可以实现“历史前置上下文 → 真实历史 → 历史后置约束”。
- 放在前面：适合把一些强约束放到真实历史之后再次强调。

预设条目支持从传统模板转换，适合把旧的一大段 prompt 拆成多个小块，后续更容易维护。

### 动态上下文策略

动态上下文是“每次请求临时生成的上下文”，例如文件树、打开标签页、当前活动文件、诊断、TODO、固定文件等。它通常不会写入真实对话历史，避免历史越来越脏。

LimCode 支持两种动态上下文保留策略：

| 策略 | 说明 | 适合场景 |
| --- | --- | --- |
| `single` | 每轮只插入当前最新的一份动态上下文；旧回合的动态上下文不会固定回放 | 大多数普通聊天，避免重复上下文占 token |
| `preserve` | 保留每个回合缓存过的动态上下文，并尽量插回原来的历史位置；新回合上下文插入到新回合位置；有利于缓存命中 | 多轮连续编辑同一批文件、需要模型记住每轮当时看到的上下文 |

使用建议：

- 日常问答、短任务：用 `single`。
- 长任务、多轮实现、审查过程中需要保持上下文位置稳定：可以用 `preserve`。
- `preserve` 会增加历史 token 压力，如果发现上下文过长，可以切回 `single` 或开启自动总结。

动态上下文策略可以在提示词模式里配置；输入区也提供“保留动态上下文发送”的入口，用于临时覆盖本次发送策略。

### 上下文感知设置

**设置 → 上下文** 控制“哪些信息可以成为动态上下文”：

- 是否发送工作区文件树。
- 文件树最大深度。
- 是否发送打开的标签页列表。
- 打开标签页最大数量。
- 是否发送当前活动编辑器路径。
- 是否发送 VS Code 诊断，以及诊断严重程度、数量限制。
- 自定义忽略模式，避免把 `node_modules`、日志、构建产物等塞进上下文。

这些开关决定变量能不能生成内容；提示词模板或预设条目里是否引用变量，则决定这些内容最终会不会被放进请求。

### 模板变量

系统提示词、动态上下文模板和预设条目内容都支持 `{{$变量名}}` 形式的变量。

常用静态变量：

| 变量 | 说明 |
| --- | --- |
| `{{$ENVIRONMENT}}` | 工作区路径、操作系统、时区、用户语言等环境信息 |
| `{{$CONTEXT_BADGE_FORMAT}}` | 输入框上下文徽章的格式说明，告诉模型 title、body、binary 标记分别代表什么 |
| `{{$TOOLS}}` | 内置工具说明，按当前渠道工具模式生成 |
| `{{$MCP_TOOLS}}` | 已连接 MCP Server 暴露的工具说明 |

常用动态变量：

| 变量 | 说明 |
| --- | --- |
| `{{$TODO_LIST}}` | 当前会话 TODO 状态 |
| `{{$WORKSPACE_FILES}}` | 工作区文件树 |
| `{{$OPEN_TABS}}` | 当前打开的编辑器标签页 |
| `{{$ACTIVE_EDITOR}}` | 当前活动编辑器路径 |
| `{{$DIAGNOSTICS}}` | VS Code 诊断信息 |
| `{{$PINNED_FILES}}` | 固定文件内容 |
| `{{$SKILLS}}` | 当前启用的 Skills 摘要或内容 |

在预设条目编辑器中，可以直接点击“插入变量”把变量追加到当前条目。

如果你升级后发现上下文说明异常，建议在提示词设置中恢复默认模板，再按需要二次修改。

### 固定文件和上下文徽章

输入区支持添加上下文徽章：

- 文件或目录。
- 当前编辑器选区。
- 附件。
- 固定文件。
- Skill。

这样可以明确告诉模型“这轮要重点看什么”。

## MCP、Skills 与 Sub-Agents

### MCP

在 **设置 → MCP** 中添加服务器：

- `stdio`：填写命令、参数和环境变量。
- `sse`：填写 SSE URL 和请求头。
- `streamable-http`：填写 HTTP URL 和请求头。

连接成功后，服务端暴露的工具会进入模型可用工具集合。某些模型对 JSON Schema 字段较挑剔，可以开启 schema 清理。

### Skills

Skills 是可复用知识模块，适合放：

- 项目约定。
- Commit 规范。
- 常用排查手册。
- 特定框架或业务知识。

启用后，AI 会看到可用 Skill 列表，并可用 `read_skill` 按需读取完整内容。

### Sub-Agents

Sub-Agents 适合把任务拆给“专门角色”，例如：

- 测试分析代理。
- 文档整理代理。
- 安全审查代理。
- 前端样式代理。

每个子代理可以设置自己的提示词和允许使用的工具范围。

## 数据存储与同步

### VS Code Settings Sync

大部分设置已经迁移到 VS Code Settings 的 `limcode.*` 命名空间，因此开启 VS Code Settings Sync 后可自动同步到其他设备，包括：

- 工具开关。
- 工具自动执行策略。
- 提示词配置。
- UI 偏好。
- Token 计数配置。
- 图像工具配置。

以下设置是机器级别，不参与同步：

- `limcode.proxy`
- `limcode.storagePath`
- `limcode.activeChannelId`

这样可以避免不同机器之间代理端口、存储路径和当前渠道互相覆盖。

### 自定义存储路径

在 **设置 → 通用** 中可以配置数据存储路径并迁移数据。迁移后需要重新加载窗口生效。

### 旧版本迁移

从旧版本升级时，LimCode 会尝试把旧的 `globalStorage/settings/settings.json` 迁移到 VS Code Settings，并备份旧文件为 `settings.json.bak`。

## 安装与更新

### 从 VS Code 插件市场安装

在扩展市场搜索：

```text
LimCode
```

找到扩展后安装即可。

### 从 VSIX 安装

1. 下载对应版本的 `limcode-*.vsix` 文件。
2. 在 VS Code 中打开命令面板：`Ctrl+Shift+P` / `Cmd+Shift+P`。
3. 执行 `Extensions: Install from VSIX...`。
4. 选择下载的 VSIX 文件。

### 从源码构建并安装

当前仓库使用 `package-lock.json`，推荐使用 npm：

```bash
# 克隆仓库
git clone https://github.com/Lianues/Lim-Code.git
cd Lim-Code

# 安装后端/扩展依赖
npm install

# 安装前端依赖
cd frontend
npm install
cd ..

# 构建扩展后端
npm run compile

# 构建前端 Webview
cd frontend
npm run build
cd ..

# 打包 VSIX
npx @vscode/vsce package
```

如果你的环境坚持使用 pnpm，也可以自行调整命令，但请注意仓库当前未提交 `pnpm-lock.yaml`。

## 本地开发

### 推荐：VS Code 调试配置

打开本仓库后，在 VS Code 的 Run and Debug 中选择：

```text
Run Extension (Local Vite Dev)
```

它会：

1. 启动后端 TypeScript watch。
2. 启动前端 Vite Dev Server，固定端口 `5173`。
3. 通过 `LIMCODE_WEBVIEW_DEV_SERVER_URL=http://127.0.0.1:5173` 让 Webview 加载本地前端资源。

Vite Dev Server 只在扩展开发模式下生效；生产构建仍使用 `frontend/dist`。

### 手动启动

```bash
# 终端 A：后端 watch
npm run watch

# 终端 B：前端 Vite dev server
npm run dev:frontend
```

然后使用普通 `Run Extension`，或自定义带 `LIMCODE_WEBVIEW_DEV_SERVER_URL` 的调试配置。

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run compile` | 编译扩展后端 TypeScript |
| `npm run watch` | 后端 TypeScript watch |
| `npm run build:frontend` | 构建前端 Webview |
| `npm run dev:frontend` | 启动前端本地开发服务器 |
| `npm run build` | 组合构建脚本；当前脚本内部调用 pnpm，无 pnpm 时请手动执行 `npm run compile` + `cd frontend && npm run build` |
| `npm test` | 运行后端 Jest 测试 |
| `npm run test:coverage` | 运行测试并生成覆盖率 |

## 项目结构

```text
Lim-Code/
├── backend/                 # 扩展后端能力
│   ├── core/                # 核心上下文、日志等
│   ├── modules/             # 渠道、配置、会话、MCP、提示词、设置等模块
│   └── tools/               # 内置工具实现
├── frontend/                # Vue 3 + Pinia + Vite Webview 前端
│   ├── src/components/      # 聊天、输入区、设置页等组件
│   ├── src/stores/          # 状态管理
│   └── src/services/        # 前端服务
├── webview/                 # VS Code Webview 消息路由和处理器
├── resources/               # 图标、字体、音效等资源
├── fast-tavern-main/        # 附带的 Fast Tavern 相关子项目
├── extension.ts             # VS Code 扩展入口
├── package.json             # 扩展清单、命令、配置和脚本
└── README.md
```

## 常见问题

### 为什么 AI 没有调用工具？

可以检查：

1. 当前渠道是否启用了工具。
2. 工具模式是否适合当前模型：原生不稳定时可尝试 `xml` 或 `json`。
3. **设置 → 工具** 中该工具是否启用。
4. 工具是否缺少依赖。
5. 当前 Prompt 模式是否限制了工具策略。

### 为什么工具执行前需要确认？

在 **设置 → 自动执行** 中可以控制每个工具是否自动执行。删除文件、执行命令、写入工作区外路径等敏感操作建议保留确认。

### 为什么读取工作区外文件失败？

`read_file` / `write_file` 对工作区外路径有独立访问策略。到 **设置 → 工具** 中展开对应工具，修改工作区外访问策略。

### 为什么模型上下文太长？

可以：

- 开启自动总结。
- 调低上下文阈值。
- 减少文件树、打开标签页、诊断等动态上下文。
- 减少固定文件数量。
- 对 Gemini 多模态历史设置图片数量上限。

### 修改后在哪里接受 Diff？

当工具生成文件修改时，VS Code 会打开 Diff 预览。编辑器标题区域和快捷键可用于接受/拒绝：

- 接受当前块：`Ctrl+Shift+Y` / macOS `Cmd+Shift+Y`
- 拒绝当前块：`Ctrl+Shift+N` / macOS `Cmd+Shift+N`
- 下一块：`Alt+]`
- 上一块：`Alt+[`

也可以使用命令：

- `LimCode: Accept All Changes`
- `LimCode: Reject All Changes`
- `LimCode: Accept Diff Block...`
- `LimCode: Reject Diff Block...`

### Windows 通知或声音没有出现？

请检查：

- **设置 → 声音** 是否启用对应事件。
- Windows 系统通知是否允许 VS Code 发送通知。
- Webview 是否已经被浏览器策略解锁音频播放。

## 贡献

欢迎提交 Issue 和 Pull Request。建议在提交前运行：

```bash
npm run compile
cd frontend && npm run build && cd ..
npm test
```

如果改动涉及前端，也建议确认 Webview 构建和本地开发模式都正常。

## 许可证

本项目采用 [MIT License](LICENSE)。

---

<p align="center">
  Made with ❤️ by LimCode Team
</p>
