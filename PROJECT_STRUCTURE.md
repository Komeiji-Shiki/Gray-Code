# GrayCode 项目结构与架构

本文描述 2.0 独立平台当前源码。主入口是 apps/desktop 和 apps/server，backend 保留平台复用的共享业务；1.x 扩展源码在 v1-extension 分支维护。

## 入口导航

| 入口 | 职责 |
| --- | --- |
| [apps/desktop/src/bootstrap.ts](apps/desktop/src/bootstrap.ts) | 桌面启动与安装器入口 |
| [apps/desktop/src/main.ts](apps/desktop/src/main.ts) | Electron 组合根、窗口、协议、IPC、原生能力与退出 |
| [apps/desktop/src/requests.ts](apps/desktop/src/requests.ts) | 桌面请求处理、兼容入口、权限与退出阶段声明 |
| [apps/server/src/application.ts](apps/server/src/application.ts) | 平台服务组合根与生命周期 |
| [apps/server/src/main.ts](apps/server/src/main.ts) | 独立 CLI、Web 服务与存储命令 |
| [packages/core/src/runtime/runtime.ts](packages/core/src/runtime/runtime.ts) | 模型/工具循环、运行状态、确认、取消与结果保存 |
| [packages/core/src/storage/database.ts](packages/core/src/storage/database.ts) | 数据库、事务、历史与记录操作 |
| [apps/client/src/App.vue](apps/client/src/App.vue) | 工作台外壳、当前项目/会话与面板 |
| [frontend/src/App.vue](frontend/src/App.vue) | 共享聊天、设置、消息与流式界面 |
| [packages/contracts/src/index.ts](packages/contracts/src/index.ts) | 平台共享类型与 RPC 契约入口 |

## 总体结构

~~~mermaid
flowchart TB
  subgraph UI[界面]
    Shell[apps/client 工作台]
    Chat[frontend 聊天与设置]
    Shell -->|iframe 桥接| Chat
  end
  Shell --> Bridge[桌面 preload / Web bridge]
  Chat --> Product[Product UI 协议]
  Bridge --> Router[ApplicationRouter]
  Product --> Router
  Router --> Application[PlatformApplication]
  Application --> Runtime[packages/core 运行器]
  Runtime --> Model[模型适配与格式器]
  Runtime --> Registry[工具目录与校验]
  Registry --> Workspace[工作区与进程]
  Registry --> MCP[MCP SDK 客户端]
  Registry --> ACP[ACP 会话服务]
  Registry --> Native[电脑 / 浏览器宿主]
  Runtime --> Storage[SQLite 存储线程]
  Storage --> Objects[内容对象 / 附件 / 不可变历史]
  Storage --> Vector[向量工作线程]
  Bots[Discord / OneBot / 自动任务 / 节点] --> Application
~~~

packages/core 不导入 Electron、VS Code、frontend 或 backend。构建脚本检查这些宿主边界。服务端通过宿主端口使用电脑、浏览器、通知等能力；独立 CLI 没有的能力不会凭空变成可用工具。

## 目录职责

| 目录 | 当前用途 |
| --- | --- |
| packages/contracts | 会话、运行、配置、电脑、浏览器、节点、ACP 和首批 RPC 类型与字段校验 |
| packages/core | 运行核心、内容存储、备份、历史、角色工作线程与记忆索引 |
| apps/server | 模型适配、提示词、工作区、Git、终端、MCP、ACP、Bot、节点和自动任务 |
| apps/desktop | Electron 窗口、内置浏览器、电脑捕获、预加载、安装更新与数据位置 |
| apps/client | 桌面/Web 外壳、文件树、编辑器、面板与远程控制界面 |
| frontend | 聊天、设置、角色与工具结果界面 |
| backend/modules | 平台复用的模型格式器、配置、提示词、MCP 与其他业务 |
| backend/tools | 共享工具实现与宿主接口，由平台提供工作区、存储和进程能力 |
| shared | 聊天协议、纯函数和跨宿主共用逻辑 |
| native/windows/ComputerHost | .NET Framework 电脑操作、窗口身份、捕获、输入与 UI Automation |
| fast-tavern-main | TypeScript 与 Python 的独立提示词引擎 |
| scripts | 构建、依赖收集、打包、检查与基准入口 |
| wiki | 随源码维护的用户手册和合成界面截图 |

## 运行与工具边界

运行开始时捕获模型、工具、工作区和相关配置，已经启动的任务继续使用捕获版本；工具目录刷新只影响之后的运行。工具目录按规范化 schema 复用参数校验器。

默认 Agent 跟随内置工具目录，但 Bot 附件、上下文笔记等环境工具不常驻，由 [prompt/service.ts](apps/server/src/prompt/service.ts) 按会话环境追加（登记见 [settings/agent.ts](apps/server/src/settings/agent.ts)）；没有内置浏览器宿主时不携带浏览器工具。工具声明随每次请求发送，是请求前缀的一部分。

独立读取可在同批最多四个并行，结果按原声明顺序保存。同一响应中连续的子代理派发一起启动，由子代理最大并发数排队。需要确认、文件写入、进程和界面动作串行。流式文本/思考增量按 16 ms 或 16 KiB 合并，结构化参数和结束事件保持边界。

确认既支持布尔选择，也支持带原始 ID 的具体选项。每次外部代理权限请求有独立审批 ID，桌面、Bot、节点和 CLI 都传回这一身份，旧回复不会消费下一次请求。


## 模型与图片

[model/adapter.ts](apps/server/src/model/adapter.ts)装配现有渠道格式器。OpenAI Chat 工具图片在完整配对工具响应后追加为图片消息；其他协议按其内容结构传递。历史图片不按“最近 N 张”淘汰。

请求图片计数遍历真实协议内容块，避开工具参数中的普通 JSON。计数跟随模型请求事件与快照保存，正文保持不变。输入用量、费用估算和供应方缓存反馈仍以各自来源为准。

正式请求与预览由上下文服务共用同一套模型准备流程，按相同顺序处理历史过滤、记忆捕获、上下文、角色历史、记忆注入和 Bot 前缀。预览使用已捕获的会话元数据，并沿途保持只读。无状态格式器使用现有注册表实例，协议输出按字段组装；角色转换按实际文本变化复制消息，附件和未变化的内容复用原对象。

## 存储与性能

历史使用不可变片段和增量游标，连续运行只读取新增部分；历史版本、分支/恢复或回收变化使旧游标失效。当前路径的完整正文以主历史为准，分支记录保存图结构及非活跃候选；历史变更与分支记录在同一事务中提交。

模型请求快照（格式版本 7）对相同消息和工具对象按内容寻址共享，读取时透明重建，旧格式记录仍可读。存储格式变更保持旧记录可读，不为优化另建平行存储。

存储操作表同时声明处理函数与向量计算期间的并发读取策略，协议新增操作时必须补齐两者。向量 top-k 在独立线程计算，相关记忆修改、恢复或备份合并成功后使向量缓存失效。

记录分页沿用 namespace、owner 与 id 索引并可指定字段投影；省略所有者时按 namespace 与 id 分页，兼容没有 owner 的旧记录。

工具搜索与项目搜索的正则计算在可终止的工作线程中执行，线程只接收查询数据，不访问或写入文件；替换结果继续交给既有版本检查与审阅流程。


## MCP 与 ACP

[McpClient](backend/modules/mcp/McpClient.ts)复用官方 MCP SDK，统一新旧协议、分页、通知与连接关闭。GrayCode 保留工具名称、账号、历史和实际进程所有权；连接包装不重复实现 JSON-RPC 解析。

[externalAgents](apps/server/src/externalAgents/service.ts)通过稳定工具接入 ACP，会话、事件、操作回执分别保存。每个会话持有自己的进程；客户端仅追加新输入，恢复使用代理能力，丢失结果不自动重放。ACP 不是单次模型生成接口，不进入 ModelProvider 的协议分支。

## 视觉操作

共享观察契约包含观察 ID、捕获时间、截图类型与尺寸。电脑窗口记录和浏览器页面记录保留各自的实际身份信息。图片像素映射由宿主完成，动作回执与后续捕获结果分别保存。

浏览器后台绘制使用同一个 WebContents 和会话，将视图挂接到可后台绘制的宿主。可见面板与后台宿主之间移动视图，不复制登录页。操作身份用于保存已执行回执，捕获失败不会导致动作自动再执行。

浏览器快照把 AX 树与同次 DOM 快照中的点击监听、pointer 光标合并，内嵌图片和 Base64 URL 在进入字符预算前省略正文。元素引用按实际 DOM 节点保存，文字点击使用 Range 与祖先布局定位；截图按图片尺寸换算到 CSS 视口，动作回执携带换算坐标和命中元素。读取快照不清除截图身份，非导航动作由标签 ID 定位页面。

## RPC、事件与界面状态

首批强类型 RPC 覆盖常用设置、文件、运行任务、电脑和浏览器方法。桌面 preload、Web bridge、服务器路由和节点电脑入口共享字段检查；业务身份与工作区校验保留在服务中。其余领域继续通过现有动态入口，逐域迁移。角色与导航的 UI 操作在 contracts 的 UiRequests 中关联参数与结果，传输仍使用 ui.request。

桌面请求在同一张处理表中声明执行函数、ui.request 兼容入口、owner 权限与关闭期间可用性，主进程负责可信 frame 校验和宿主生命周期。

成熟聊天协议通过 ProductUi/ProductChat 映射到平台服务，桥接本身不拥有第二个运行器。设置加载使用请求序号，旧响应不能覆盖新状态；共享设置核心按异步调用链区分嵌套写入和独立请求，独立请求完整排队。

事件订阅者的异常分别处理。HTTP SSE 使用有界队列，过慢连接完成已接受的帧后重置，由最后成功交付的位置重连补发。


## 生命周期与恢复

工作区进程、终端、MCP 和 ACP 持有实际子进程对象，停止只处理所持有的进程树。结束命令保留结果记录并释放句柄。应用关闭依次停止入口与任务，清理等待、连接、受管进程，最后关闭存储。

Windows 原生宿主提供独立的 `--process-snapshot` 只读入口。桌面终端使用进程快照和创建时间核对后代，身份未知的记录保留在查询结果中；可能属于本命令时再通过原 CIM 查询核对。源码运行没有原生宿主时继续使用 CIM。

Bot、节点、自动任务与子任务复用运行核心。事务领取、稳定请求身份、事件序号和完成回执负责恢复与去重。节点断线补取状态和结果，不盲目重发命令。

## 构建与测试

[build-platform.mjs](scripts/build-platform.mjs)生成核心、存储/向量/角色工作线程、服务端与 CLI，并检查宿主依赖。[build-desktop.mjs](scripts/build-desktop.mjs)先执行平台构建，再生成桌面主进程、preload、终端宿主和构建信息，并复用本轮编译的原生宿主。平台、桌面和打包所需的运行依赖统一由 [desktop-runtime-dependencies.mjs](scripts/desktop-runtime-dependencies.mjs)声明，正式打包收集真实依赖及许可证并核对必要入口。

[generate-tool-meta.mjs](scripts/generate-tool-meta.mjs) 使用 TypeScript 语法树静态提取工具声明，支持纯数据常量的相对导入和对象展开；动态字段保留标记，生成时不执行工具工厂或宿主代码。文档工具的读写属性来自原声明，TODO、Plan、Progress 共用条目结构和参数 schema，各领域保留自己的校验规则。

测试位置为 backend/__tests__、frontend/src 下的测试目录及 packages/core/tests。命令、选择范围与发行检查见[贡献指南](CONTRIBUTING.md)。用户流程与数据含义见 [Wiki](wiki/Home.md)。
