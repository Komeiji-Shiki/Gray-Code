# GrayCode 项目结构与架构

本文描述 2.0 独立平台当前源码。主入口是 apps/desktop 和 apps/server；旧目录中仍有共享业务和扩展兼容代码，目录名称不能直接等同于运行边界。

## 入口导航

| 入口 | 职责 |
| --- | --- |
| [apps/desktop/src/bootstrap.ts](apps/desktop/src/bootstrap.ts) | 桌面启动与安装器入口 |
| [apps/desktop/src/main.ts](apps/desktop/src/main.ts) | Electron 组合根、窗口、协议、IPC、原生能力与退出 |
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

packages/core 不导入 Electron、VS Code、frontend、webview 或 backend。构建脚本检查这些宿主边界。服务端通过宿主端口使用电脑、浏览器、通知等能力；独立 CLI 没有的能力不会凭空变成可用工具。

## 目录职责

| 目录 | 当前用途 |
| --- | --- |
| packages/contracts | 会话、运行、配置、电脑、浏览器、节点、ACP 和首批 RPC 类型与字段校验 |
| packages/core | 运行核心、内容存储、备份、历史、角色工作线程与记忆索引 |
| apps/server | 模型适配、提示词、工作区、Git、终端、MCP、ACP、Bot、节点和自动任务 |
| apps/desktop | Electron 窗口、内置浏览器、电脑捕获、预加载、安装更新与数据位置 |
| apps/client | 桌面/Web 外壳、文件树、编辑器、面板与远程控制界面 |
| frontend | 成熟聊天、设置、角色与工具结果界面；也供扩展入口复用 |
| backend/modules | 仍被平台复用的模型格式器、配置、提示词、MCP 与其他业务；也包含扩展路径 |
| backend/tools | 共享工具实现及宿主适配；例如 readFileRuntime 与 VS Code 外壳分开 |
| shared | 聊天协议、纯函数和跨宿主共用逻辑 |
| native/windows/ComputerHost | .NET Framework 电脑操作、窗口身份、捕获、输入与 UI Automation |
| webview、extension.ts | 保留的 VS Code 宿主入口，独立桌面不从该入口启动 |
| fast-tavern-main | TypeScript 与 Python 的独立提示词引擎 |
| scripts | 构建、依赖收集、打包、检查与基准入口 |
| wiki | 随源码维护的用户手册和合成界面截图 |

## 运行与工具边界

运行开始时捕获模型、工具、工作区和相关配置。工具目录按规范化 schema 复用校验器；目录刷新清理不再使用的当前缓存，已经启动的任务继续使用捕获版本。

独立读取可在同批最多四个并行，结果按原声明顺序保存。需要确认、文件写入、进程和界面动作继续串行。流式文本/思考增量按 16 ms 或 16 KiB 合并，结构化参数和结束事件保持边界，结束前刷新缓冲。

确认既支持传统布尔选择，也支持带原始 ID 的具体选项。每次外部代理权限请求有独立审批 ID，桌面、Bot、节点和 CLI 都传回这一身份，旧回复不会消费下一次请求。

## 模型与图片

[model/adapter.ts](apps/server/src/model/adapter.ts)装配现有渠道格式器。OpenAI Chat 工具图片在完整配对工具响应后追加为图片消息；其他协议按其内容结构传递。历史图片不按“最近 N 张”淘汰。

请求图片计数遍历真实协议内容块，避开工具参数中的普通 JSON。计数跟随模型请求事件与快照保存，正文保持不变。输入用量、费用估算和供应方缓存反馈仍以各自来源为准。

## 存储与性能

历史使用不可变片段和增量游标，连续运行避免反复解压完整消息列表。追加与尾部修改更新对应后缀；历史版本、分支/恢复或回收变化使旧游标失效。

格式版本 7 为模型请求快照引入值引用。相同消息和工具对象按内容寻址共享，已有 object_edges 同时关联这些值与附件。读取透明重建完整结构，旧格式记录仍可读；SQL 表布局没有为该优化另建一套快照数据库。

向量候选缓存在相关记忆修改后失效，精确 top-k 在独立线程计算，存储线程可处理其他读取。写入保持原队列顺序。文件树采用可见行渲染和父目录局部刷新。

## MCP 与 ACP

[McpClient](backend/modules/mcp/McpClient.ts)复用官方 MCP SDK，统一新旧协议、分页、通知与连接关闭。GrayCode 保留工具名称、账号、历史和实际进程所有权；连接包装不重复实现 JSON-RPC 解析。

[externalAgents](apps/server/src/externalAgents/service.ts)通过稳定工具接入 ACP，会话、事件、操作回执分别保存。每个会话持有自己的进程；客户端仅追加新输入，恢复使用代理能力，丢失结果不自动重放。ACP 不是单次模型生成接口，不进入 ModelProvider 的协议分支。

## 视觉操作

共享观察契约包含观察 ID、捕获时间、截图类型与尺寸。电脑窗口记录和浏览器页面记录保留各自的实际身份信息。图片像素映射由宿主完成，动作回执与后续捕获结果分别保存。

浏览器后台绘制使用同一个 WebContents 和会话，将视图挂接到可后台绘制的宿主。可见面板与后台宿主之间移动视图，不复制登录页。操作身份用于保存已执行回执，捕获失败不会导致动作自动再执行。

## RPC、事件与界面状态

首批强类型 RPC 覆盖常用设置、文件、运行任务、电脑和浏览器方法。桌面 preload、Web bridge、服务器路由和节点电脑入口共享字段检查；业务身份与工作区校验保留在服务中。其余领域继续通过现有动态入口，逐域迁移。

成熟聊天协议通过 ProductUi/ProductChat 映射到平台服务，桥接本身不拥有第二个运行器。两个 Vue 根与 iframe 保留既有功能；设置加载使用请求序号，旧响应与旧错误不能覆盖新状态。

事件订阅者的异常分别处理。HTTP SSE 使用有界队列，过慢连接完成已经接受的帧后重置；单个较大帧不会被截成不可解析的半条消息。

## 生命周期与恢复

工作区进程、终端、MCP 和 ACP 持有实际子进程对象，停止只处理所持有的进程树。结束命令保留结果记录并释放句柄。应用关闭依次停止入口与任务，清理等待、连接、受管进程，最后关闭存储。

Bot、节点、自动任务与子任务复用运行核心。事务领取、稳定请求身份、事件序号和完成回执负责恢复与去重。节点断线补取状态和结果，不盲目重发命令。

## 构建与测试

[build-platform.mjs](scripts/build-platform.mjs)生成核心、存储/向量/角色工作线程、服务端与 CLI，并检查宿主依赖。[build-desktop.mjs](scripts/build-desktop.mjs)生成桌面主进程、preload、终端宿主和构建信息。正式打包收集真实生产依赖及许可证，核对必要入口。

测试位置为 backend/__tests__、frontend/src 下的测试目录及 packages/core/tests。命令、选择范围与发行检查见[贡献指南](CONTRIBUTING.md)。用户流程与数据含义见 [Wiki](wiki/Home.md)。
