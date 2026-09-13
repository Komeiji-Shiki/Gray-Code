# Node.js 调试器

`js-debug/` 原样来自 Microsoft 的独立 DAP 发行包，不包含 VSIX 宿主。

- 项目：https://github.com/microsoft/vscode-js-debug
- 版本：v1.117.0
- 发行包：https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz
- 原始压缩包 SHA-256：`ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772`
- 许可证：MIT，保留在 `js-debug/LICENSE`，其余依赖声明随原发行内容保留。

启动入口为 `js-debug/src/dapDebugServer.js`。升级时核对官方资产摘要，再整体替换此目录；不要单独改动生成的适配器文件。
