# GrayCode 独立桌面

桌面主进程位于 apps/desktop，工作台外壳位于 apps/client，聊天与设置复用 frontend。应用服务和运行核心分别位于 apps/server、packages/core。

[完整使用手册](../../wiki/Home.md) · [架构](../../PROJECT_STRUCTURE.md) · [开发与验证](../../CONTRIBUTING.md)

## 使用

从[发行页](https://github.com/Komeiji-Shiki/Gray-Code/releases)选择对应 Windows 包。便携版完整解压运行 GrayCode.exe，安装版使用 Setup。当前源码是 2.0.0-pre.2，发行附件对应其发布提交。

在“设置 → 渠道”配置模型，选择工作区后开始任务。工作台可展开文件、编辑器、终端、Git、差异和浏览器。设置分类共享草稿；模式切换保持会话。

电脑工具默认截图观察，浏览器支持坐标动作与后台截图。启用多模态后工具图片进入选定模型端点，已有图片不会因新增图片自动删除。[视觉工具](../../wiki/Visual-Tools.md)说明坐标与操作回执。

“设置 → 开发”可以配置 ACP 编码程序。Kimi Code 示例为命令 kimi、参数 acp。程序由具体任务启动，保存配置不会启动代理；[代理手册](../../wiki/Agents-and-MCP.md)说明恢复和权限选项。

## 构建

~~~powershell
npm ci
npm --prefix frontend ci
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
~~~

要求 Node.js 22.15 或更新版本。Windows 电脑宿主使用系统 .NET Framework 4 编译器；脚本同时生成平台和桌面各自需要的原生产物。

~~~powershell
npm run ci
npm run package:desktop
~~~

package:desktop 先执行正式 build:desktop，再生成 release/desktop/GrayCode-win32-x64。设置 GRAYCODE_DESKTOP_OUT 可以指定另一个输出目录。目标程序仍运行或必要入口缺失时，打包会停止并报告原因。

build:desktop:trial 只编译快速试用产物。正式构建和最终验证记录对应提交；包内 apps/desktop/dist/build-info.json 保存构建信息。源码变更后不要直接复用不匹配的旧前端或原生宿主。

## 数据与便携配置

默认任务数据位于 %APPDATA%/GrayCode/platform-data。--data 指定独立目录，开发和验证用它隔离应用数据。

便携版在程序旁维护 portable-data 配置副本，包含渠道、提示词、MCP、用户技能与外观等配置。settings.enc 和 profile.key 配套携带。聊天、检查点、项目目录与账号授权仍属于本机任务数据；换电脑迁移完整内容使用程序数据备份，并另行处理项目源码。

外部 ACP 程序的会话文件由该程序保存，恢复 GrayCode 的会话 ID 后仍需要对应程序能恢复原会话。[数据手册](../../wiki/Data-and-Diagnostics.md)列出备份范围。

## 安装更新与回退

安装版默认位于 %LOCALAPPDATA%/GrayCode，也可给 Setup 传入 --installto。应用内更新设置提供下载、离线更新和确认重启。离线更新选择与完整 .nupkg 位于同一目录的 releases.win-x64.json。

更新流程保留原程序包，并在切换前备份任务数据。恢复上一版本时配对恢复程序和数据，原目录保留。当前存储格式为 7，旧程序不能读取新版格式，因此降级不能只替换 exe。

安装中断的恢复入口位于用户配置目录 desktop-updates 下的 recovery-* 文件夹，Restore-GrayCode.cmd 用于核对旧包并修复程序。卸载保留安装目录之外的用户数据。

## 多端与交付范围

Web 入口、Discord、OneBot 和配对设备共用平台服务。Web 部署参见 [WEB.md](../server/WEB.md)，功能流程见[自动任务与多端](../../wiki/Automation-and-Devices.md)。

Windows x64 是当前构建与本机验收平台。Linux/macOS 发行、真实手机、混合 DPI、多屏及具体外部模型和 Bot 部署需要各自验证。[性能与验证](../../wiki/Performance-and-Validation.md)区分合成测试和实际环境结果。

桌面包携带运行依赖、原生电脑宿主、调试器和[第三方原始许可](../../resources/licenses/README.md)，应保留整个程序目录。
