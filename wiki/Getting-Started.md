# 开始使用

[返回目录](Home.md)

## 安装与数据位置

Windows x64 便携包完整解压后运行 GrayCode.exe。保留程序目录中的 DLL、resources 和其他配套文件。安装版使用发行页对应的 Setup，默认安装到当前用户的 %LOCALAPPDATA%/GrayCode；数据与程序目录分开。

应用任务数据默认位于 %APPDATA%/GrayCode/platform-data。源码开发或独立验证可以显式传入 --data，例如：

~~~powershell
npm run desktop -- --data .tmp/desktop-local
~~~

便携版另有随程序携带的 portable-data 配置副本。模型渠道、提示词、MCP、用户技能和外观可随配置移动；聊天、工作区与账号授权仍使用本机任务数据。移动程序和迁移完整历史是两件事，完整数据使用备份恢复功能。

## 配置第一个模型

打开设置的“渠道”，选择接口格式，填写地址、API 凭据和模型。兼容接口按照服务商提供的格式填写，实际工具、图片和思考能力取决于端点。

先保存渠道，再回到输入框选择渠道和模型。需要模型读取图片时，在该渠道启用多模态，并选择支持图片输入的模型。系统提示、工具模式、上下文限制、重试和思考选项按渠道配置；当前会话也可以临时选择可用的思考强度。

设置页中编辑的内容先进入共享草稿。“保存全部”提交各分类修改；关闭前可以继续编辑或放弃。启动 Bot、连接服务等动作读取已保存配置。

## 第一次编码任务

添加或选择本机工作区，再新建编码任务。例如：

> 阅读项目结构，解释主要模块，找到一个能够复现的问题，修复后运行相关检查。

模型根据当前任务允许的工具搜索、读取、修改文件并运行命令。需要确认时，工具卡片显示具体请求。文件改动可以在差异面板审阅；终端和运行记录用于查看输出与错误。

消息发送后可以编辑重试或重生成回答，候选分支保留在会话中。模式切换仍保留当前会话；在另一个工作树开始新任务时使用工作树列表的“新建任务”。

## 从源码构建

~~~powershell
npm ci
npm --prefix frontend ci
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
~~~

根目录采用 npm workspaces，frontend/ 有独立锁文件，需要单独安装。Windows 电脑宿主使用系统 .NET Framework 4 编译器；具体工具链见[贡献指南](../CONTRIBUTING.md)。正式便携包执行 npm run package:desktop，输出目录与运行说明见[桌面构建](../apps/desktop/README.md)。

## 命令行与 Web

共享平台服务可以脱离桌面外壳运行：

~~~powershell
npm run build:platform
npm run platform -- --help
npm run platform -- --data .tmp/platform-local info
~~~

CLI 的 chat 运行模型与工具任务，serve 提供 RPC、事件流和可选 Web 界面；list、history、verify 等用于读取和检查数据。--data 明确选择当前任务数据目录。

Web 入口可以从桌面设置中启用，也可以通过 CLI 的 serve --web 启动。凭据通过 --token-env 指定的环境变量读取，外部 HTTPS 地址使用 --public-origin。部署参数、登录与代理设置见 [Web 服务说明](../apps/server/WEB.md)。浏览器页面里的项目文件来自运行服务的电脑。

## 更新与恢复

便携版选择新的程序目录，退出旧版后再启动；安装版通过桌面更新设置下载并确认重启安装。离线更新使用匹配的 releases.win-x64.json 与完整 .nupkg。

当前存储格式为版本 7。旧格式可由新版打开升级，旧程序不能读取新版格式；需要退回程序和数据时，使用对应的更新前备份。备份内容与项目源码的关系见[数据与诊断](Data-and-Diagnostics.md)。
