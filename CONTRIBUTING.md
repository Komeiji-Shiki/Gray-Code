# 参与 GrayCode 开发

当前主线以 2.0 独立平台为中心。先阅读[架构导航](PROJECT_STRUCTURE.md)，确认修改属于运行核心、应用服务、宿主还是界面。保留的扩展构建和桌面构建是不同入口。

## 环境与首次启动

需要 Node.js 22.15 或更新版本及 npm。Windows 原生电脑宿主使用系统 .NET Framework 4 的 csc.exe，构建脚本定位到 Windows/Microsoft.NET/Framework64/v4.0.30319。构建原生 npm 依赖时，若没有匹配的预编译产物，需按依赖要求准备编译工具。

~~~powershell
npm ci
npm --prefix frontend ci
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
~~~

根目录包含 packages/* 与 apps/* 工作区；frontend 有独立锁文件。开发使用明确的数据目录，便于复现和清理自己的测试数据。CLI 帮助：

~~~powershell
npm run build:platform
npm run platform -- --help
~~~

## 修改边界

- contracts 定义跨端数据与首批 RPC 契约；新增字段同步检查写入、读取、列表、备份恢复和旧数据读取。
- core 不依赖 Electron、VS Code 或旧界面目录；实际宿主能力通过应用服务与端口注入。
- 共享业务仍有调用者时保留职责，不为目录名称建立新的包装层。领域内部的重复协议实现优先交给已有正式依赖。
- 模型请求保持既有消息与图片顺序；新增输入不删除旧图。改变工具目录、系统提示或压缩边界时明确其请求前缀影响。
- 修改文件使用现有差异与版本流程；受管进程根据持有对象处理，先确认真实身份。
- 前端修改前阅读所在目录 AGENTS.md 和本机 UI 参考。保持现有设置入口、模式切换和聊天编辑/重生成行为。

新注释说明原因和边界，避免重复代码表面含义。中文提交按一个可独立说明的阶段组织；目录移动与行为修改尽量分开。

## 验证入口

| 命令 | 范围 |
| --- | --- |
| npm run typecheck:all | core、server、根共享代码、测试、desktop、client 与 frontend |
| npm test | backend 的 Jest 回归 |
| npm --prefix frontend test | 共享界面的 Vitest 回归 |
| npm run test:platform | 先构建平台，再运行核心与服务端集成测试 |
| npm run ci | 上述检查，加 TypeScript/Python 提示词引擎与国际化检查 |
| npm run build:desktop | 正式平台、桌面和两个界面构建 |
| npm run package:desktop | 正式桌面构建后生成便携包 |
| npm run package:installer | 从对应便携输出生成安装与更新交付物 |

开发中先做必要的快速检查，主要回归在修改完成后集中执行。相同条件已经通过时，无需不断重复整套测试。示例：

~~~powershell
npx jest --config jest.platform.config.cjs --runInBand packages/core/tests/externalAgents.test.ts
npm --prefix frontend test -- src/__tests__/components/StaticGuards.test.ts
~~~

MCP 与 ACP 使用真实本机 stdio/HTTP 夹具；节点使用隔离数据和实际本机 TLS。测试只关闭自己启动并持有的子进程。Windows 的沙箱或权限限制可能阻止进程树清理，应在能管理这些测试子进程的环境运行。

ACP 官方 SDK 使用 ESM，平台 Jest 仅转换该依赖的 JavaScript；生产 esbuild 继续正常打包，不为测试修改全局模块解析规则。

## UI 与桌面验证

类型和组件测试不能代替真实流程。受影响的桌面场景使用隔离应用数据与合成模型端点验证：启动、发送、编辑、重生成、确认、取消、设置、截图、工作树和退出。

截图操作要确认实际目标、返回图片尺寸和动作结果。动作后截图失败与动作失败分别验证。后台浏览器同时检查可见/后台切换和同一页面身份。真实外部模型、Bot 或双设备结果单独记录来源。

本批次性能数据与限制见[性能与验证](wiki/Performance-and-Validation.md)。临时测量放在忽略目录；需要长期防止回归的场景加入现有测试结构。

## 打包与构建身份

~~~powershell
$env:GRAYCODE_DESKTOP_OUT = 'release/desktop-local'
npm run package:desktop
~~~

默认输出是 release/desktop/GrayCode-win32-x64。打包前检查目标程序占用和必要产物，收集独立运行依赖、原生电脑宿主、调试器与许可证。build-info.json 记录提交、工作区是否有修改和构建时间；验收应记录实际包的构建身份。

build:desktop:trial 与各 package-only 参数用于快速编译，不是完整验证的替代品。根 build 仍是保留的扩展构建；独立桌面使用 build:desktop。

## 文档与发行

README 介绍当前产品入口，wiki/ 保存可随源码审阅的详细手册，PROJECT_STRUCTURE 描述真实依赖边界。可复现截图使用合成内容并放在 wiki/assets。新协议依赖同步保存原始许可，见[来源记录](resources/licenses/README.md)。

修改完成后记录问题、最终行为、相关验证、数据格式兼容性和剩余的实际环境限制。版本、tag、公开发布和默认分支推送按当次交付范围执行。功能分支提交保持可独立审阅。
