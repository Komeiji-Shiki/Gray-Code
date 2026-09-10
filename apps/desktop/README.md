# GrayCode 2.0 独立桌面预览

当前版本为 `2.0.0-pre`，提供 Windows x64 便携程序。下载入口见 [GitHub 预发布](https://github.com/Komeiji-Shiki/Gray-Code/releases/tag/v2.0.0-pre)。Linux/macOS 的发行与运行验证尚未完成。

## 使用

完整解压 Windows ZIP 后运行 `GrayCode.exe`，保留同目录中的 DLL 与 resources。更新时先从托盘退出旧版，再打开新目录中的程序。预览版更新不要求删除旧程序目录。

在“设置 → 渠道”添加模型渠道，再选择模型和工作区。设置分类共用一份草稿，通过“保存全部”提交；连接机器人等即时操作使用已保存配置。数据默认保存在系统用户数据目录内的 `platform-data`，可以通过 `--data` 指定其他目录。

首次启动且尚无渠道配置时，程序可以从本机旧编辑器配置中只读复制可识别设置。会话、分支、附件和文件检查点通过“旧存档迁移”显式导入，迁移结果以界面报告为准，未处理或冲突的来源会保留。

## 从源码构建

使用 Node.js 22.15 或更新的 22.x 版本。首次安装和运行：

```powershell
npm ci
npm --prefix frontend ci
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
```

生成 Windows 便携包：

```powershell
npm run package:desktop
```

默认输出为 `release/desktop/GrayCode-win32-x64`。`GRAYCODE_DESKTOP_OUT` 可指定新的发行目录，避免覆盖正在使用的程序。`package:desktop` 编译运行产物，常规开发构建 `build:desktop` 另包含类型检查。首次构建需要下载 Electron 运行时。

## 主要能力

- Monaco 编辑器、文件审查、原生终端、Git、语言服务和内置浏览器。
- 多模型渠道、MCP、Skills、长期记忆、角色卡与世界书。
- [共享团队任务](../server/src/teams/README.md)：依赖关系、原子领取、执行所有权、事件等待与持久消息顺序。
- [上下文管理](../server/src/context/README.md)：完整前缀总结或笔记换窗口，保留原历史及恢复工具。
- Discord 与可选 OneBot 接入，以及复用同一应用实例的 [Web 入口](../server/WEB.md)。

机器人使用各自设置页中的凭据、频道范围和账号绑定；昵称或引用内容不能授予权限。Discord 的背景消息与图片读取受其 Message Content Intent 和频道权限约束。普通成员的能力由服务端检查。

## 预览范围

本版包括已有定向测试和 Windows 隔离桌面流程的验证，不代表全部模型供应方、机器人环境或历史数据组合都已覆盖。迁移和远程连接出现问题时，请附上可复现步骤与脱敏后的错误信息。不要在公开问题中上传令牌、真实会话或完整配置导出。

`apps/server` 提供共享应用服务，`packages/core` 管理 SQLite 存储及任务运行；`apps/desktop` 提供原生宿主能力，`apps/client` 提供工作台外壳，聊天界面复用 `frontend/`。
