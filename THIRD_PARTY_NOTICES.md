# Third-party notices / 第三方来源与许可

GrayCode's root license applies to its own covered code, not to every item shipped with the application. Preserve the original notices below and the license files shipped inside dependency packages. Versions and integrity values for npm packages are locked by `package-lock.json` and `frontend/package-lock.json`.

| Component | Applicable notice and source |
| --- | --- |
| Historical LimCode / GrayCode contributions | Original [MIT notice](LICENSES/MIT-legacy.txt), through baseline `9fe9efa909f9afd7240d05b349908050a188baa1`; Git history retains authorship and provenance |
| fast-tavern TypeScript and Python engines | [MIT](fast-tavern-main/LICENSE), with the existing package declarations and repository history retained |
| ACP SDK | Apache-2.0; [original notice](resources/licenses/acp-sdk.txt), [upstream](https://github.com/agentclientprotocol/typescript-sdk) |
| MCP client/core | MIT and Apache-2.0 contributions as stated by the upstream transition notice; preserve [client](resources/licenses/mcp-client.txt) and [core](resources/licenses/mcp-core.txt) texts, [upstream](https://github.com/modelcontextprotocol/typescript-sdk) |
| Velopack | [Original notice](resources/licenses/velopack.txt), [upstream](https://github.com/velopack/velopack); distributed packages also retain their own license files |
| Microsoft JavaScript debugger | [Original MIT notice](resources/debuggers/js-debug/LICENSE), [upstream](https://github.com/microsoft/vscode-js-debug) |
| pixi-live2d-display 0.4.0 wrapper | [MIT notice](apps/client/src/pets/vendor/LICENSE), [source and immutable hashes](apps/client/src/pets/vendor/provenance.json), [upstream tag](https://github.com/guansss/pixi-live2d-display/tree/v0.4.0) |
| Cubism Web Framework within the player | [Original component notice](apps/client/src/pets/vendor/CUBISM-LICENSE.md), Framework commit `1f9cdfd140e87ba0ae68a356bb5ec339a0e65f99`, [source](https://github.com/guansss/CubismWebFramework/tree/1f9cdfd140e87ba0ae68a356bb5ec339a0e65f99); Live2D terms remain applicable, with the limited GrayCode-side exception described in LICENSING.md |
| Cubism Core and user models | Obtained separately by the user; not supplied or relicensed by GrayCode. Core, model, texture and animation rights must be obtained from their respective licensors |
| sharp / libvips and platform binaries | Apache-2.0, LGPL-3.0-or-later and notices in the actual installed `sharp` / `@img/*` packages; [sharp source and releases](https://github.com/lovell/sharp), [libvips source and releases](https://github.com/libvips/libvips), [build recipe and source versions](https://github.com/lovell/sharp-libvips) |
| DOMPurify | Package offers MPL-2.0 OR Apache-2.0; use the Apache-2.0 option for this combination and preserve the original notice; [source](https://github.com/cure53/DOMPurify) |
| Electron and Chromium components | Original notices shipped with Electron, including its third-party notices; [source](https://github.com/electron/electron) |
| Other npm libraries, fonts and resources | Original per-component licenses and provenance, including the original notices retained in bundles and installed production packages |

## Source and binary distribution

The GrayCode source archive contains the tracked application source, local vendored files, dependency locks and build/install scripts. It is not a claim that the archive contains every third-party upstream source tree. Distributors must also provide or make available the exact third-party Corresponding Source required by the applicable licenses, including modifications and necessary build/relink materials when required. Use the binary package version and its notices to identify the corresponding upstream release; a moving repository branch is not an exact source reference.

In particular, LGPL components such as libvips retain their own source and replacement/relinking requirements. The Cubism exception does not waive obligations for libvips, unrelated libraries, or GrayCode itself. Updating a binary dependency requires updating its corresponding notices and source information together.

桌面打包会保留本文件、项目许可、历史 MIT 声明、已有 SDK 许可和实际复制的生产依赖许可。用户自行导入的模型与 Core 不进入源码包或公开发行包。
