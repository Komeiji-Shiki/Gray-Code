# 打包组件的许可来源

桌面打包器将本目录原样复制到 `resources/app/resources/licenses`。这里保留已打入主进程的组件许可；作为独立生产依赖复制的包继续携带其自身许可文件。

| 文件 | 组件与锁定版本 | 来源 |
| --- | --- | --- |
| `office-xml.txt` | adm-zip 0.6.1、fast-xml-parser 5.11.2 及其 XML/实体解析依赖 | 安装包原始许可全文与版本，供 Office 文件的 ZIP/XML 局部编辑使用；[adm-zip](https://github.com/cthackers/adm-zip)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)。 |
| 运行时包中的 `LICENSE` | docx 9.8.1、ExcelJS 4.4.0、PptxGenJS 4.0.1 | 各安装包原始 MIT 许可；[docx](https://github.com/dolanmiu/docx)、[ExcelJS](https://github.com/exceljs/exceljs)、[PptxGenJS](https://github.com/gitbrent/PptxGenJS)。桌面按生产依赖闭包复制包及其传递依赖，保留各自许可。 |
| `jose.txt` | jose 6.2.12（沿用工作区锁定版本，server 显式声明直接依赖） | 安装包原始 `LICENSE.md`，MIT；[官方源码](https://github.com/panva/jose) |
| `ajv.txt` | Ajv 8.20.0（沿用工作区已有版本，server 显式声明直接依赖） | 安装包原始 `LICENSE`，MIT；[官方源码](https://github.com/ajv-validator/ajv) |
| `iconv-lite.txt` | iconv-lite 0.6.3（沿用工作区锁定版本，用于文件工具按原编码读写 GBK、Shift-JIS、Big5 等文本） | 安装包原始 `LICENSE`，MIT；[官方源码](https://github.com/ashtuchkin/iconv-lite) |
| `safer-buffer.txt` | safer-buffer 2.1.2（iconv-lite 的依赖） | 安装包原始 `LICENSE`，MIT；[官方源码](https://github.com/ChALkeR/safer-buffer) |
| `acp-sdk.txt` | `@agentclientprotocol/sdk` 1.5.0 | 安装包原始 `LICENSE`，Apache-2.0；[官方源码](https://github.com/agentclientprotocol/typescript-sdk) |
| `mcp-client.txt` | `@modelcontextprotocol/client` 2.0.0 | 安装包原始 `LICENSE`；[官方源码](https://github.com/modelcontextprotocol/typescript-sdk) |
| `mcp-core.txt` | `@modelcontextprotocol/core` 2.0.0 | 安装包原始 `LICENSE`；[官方源码](https://github.com/modelcontextprotocol/typescript-sdk) |
| `velopack.txt` | Velopack，版本由根锁文件确定 | Windows 安装与更新运行库的原始许可 |

MCP 2.0.0 的包元数据标为 MIT，但随包 `LICENSE` 说明项目正向 Apache-2.0 迁移，未获重授权的贡献继续适用原 MIT 许可。此处保留完整原文，不把包元数据简写当成统一授权结论。ACP 与 MCP SDK 未修改上游源码，由 esbuild 合并进平台与桌面产物；GrayCode 的连接和会话适配在各自业务模块内。

其他独立分发资源：JavaScript 调试器在 `resources/debuggers/js-debug/LICENSE`，桌宠播放器的来源与 Cubism 说明在 `apps/client/src/pets/vendor/`。这些组件与 GrayCode 自有代码的 [AGPL 及限定例外](../../LICENSING.md) 分别适用。更新对应依赖时同步核对原始许可与本表，并保留 [历史 MIT 声明](../../LICENSES/MIT-legacy.txt)。
