# 打包组件的许可来源

桌面打包器将本目录原样复制到 `resources/app/resources/licenses`。这里保留已打入主进程的组件许可；作为独立生产依赖复制的包继续携带其自身许可文件。

| 文件 | 组件与锁定版本 | 来源 |
| --- | --- | --- |
| `acp-sdk.txt` | `@agentclientprotocol/sdk` 1.5.0 | 安装包原始 `LICENSE`，Apache-2.0；[官方源码](https://github.com/agentclientprotocol/typescript-sdk) |
| `mcp-client.txt` | `@modelcontextprotocol/client` 2.0.0 | 安装包原始 `LICENSE`；[官方源码](https://github.com/modelcontextprotocol/typescript-sdk) |
| `mcp-core.txt` | `@modelcontextprotocol/core` 2.0.0 | 安装包原始 `LICENSE`；[官方源码](https://github.com/modelcontextprotocol/typescript-sdk) |
| `velopack.txt` | Velopack，版本由根锁文件确定 | Windows 安装与更新运行库的原始许可 |

MCP 2.0.0 的包元数据标为 MIT，但随包 `LICENSE` 说明项目正向 Apache-2.0 迁移，未获重授权的贡献继续适用原 MIT 许可。此处保留完整原文，不把包元数据简写当成统一授权结论。ACP 与 MCP SDK 未修改上游源码，由 esbuild 合并进平台与桌面产物；GrayCode 的连接和会话适配在各自业务模块内。

其他独立分发资源：JavaScript 调试器在 `resources/debuggers/js-debug/LICENSE`，桌宠播放器的来源与 Cubism 说明在 `apps/client/src/pets/vendor/`。这些组件与 GrayCode 自有代码的 [MIT 许可](../../LICENSE) 分别适用。更新对应依赖时同步核对原始许可与本表。
