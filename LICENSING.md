# GrayCode licensing / 授权说明

GrayCode is licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`), with the limited additional permission in [the GrayCode Cubism combination exception](LICENSES/GrayCode-Cubism-exception.txt). The complete AGPL text is in [LICENSE](LICENSE). The version-selection notice in this paragraph applies to GrayCode; the example notice in the AGPL appendix does not select a later version for this project.

GrayCode 自有代码采用 AGPL 第 3 版，并提供范围限定的 Cubism 组合许可例外。分发和运行受覆盖的修改版时，应遵守 AGPL 的对应源码要求；该授权允许商业使用和收费。

## Scope and migration boundary / 范围与迁移边界

This notice takes effect with the first commit introducing this file after the MIT baseline `9fe9efa909f9afd7240d05b349908050a188baa1` (2026-09-24 migration). It applies to GrayCode-authored additions and modifications from that point, and to the resulting combined GrayCode program, subject to the preserved permissions and exceptions below. It is not an assertion of exclusive copyright ownership over historical contributions.

Earlier copies remain available under the terms under which they were received. [LICENSES/MIT-legacy.txt](LICENSES/MIT-legacy.txt) preserves the preceding root MIT license, including the LimCode Team and GrayCode Team copyright notices. Historical material and other permissively licensed contributions retain their original permissions and attribution. That file does not offer MIT as an alternative license for all future GrayCode code.

本次切换不会撤回旧版本的 MIT 授权，也不会把其他作者的版权转让给 GrayCode。历史来源的原有许可继续有效；后续 GrayCode 新代码按本说明发布。

The default scope includes GrayCode code in `apps/`, `packages/`, `backend/`, `frontend/`, `shared/`, `webview/`, `native/`, build scripts, and the extension entry point, unless a more specific third-party notice applies. Repository documentation follows the same default unless otherwise marked. Models, user content and third-party assets retain their own rights.

`fast-tavern-main/` remains an MIT-licensed component under its own [LICENSE](fast-tavern-main/LICENSE). Vendored libraries, SDKs, debugger files, fonts and other third-party materials keep their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). A package metadata label never overrides a component's original license text.

## Live2D

The Cubism exception authorizes the specified combination on the GrayCode side only. The wrapper's MIT license, Framework's Live2D license, and separately obtained Core's Live2D license remain distinct. Framework identity is pinned in [provenance.json](apps/client/src/pets/vendor/provenance.json). GrayCode does not distribute Cubism Core or grant Live2D publication rights.

Distributors and users must obtain any Live2D permissions required for their own use and distribution, including any publication agreement applicable to their application. The exception is not a claim that Live2D has approved GrayCode, and it does not remove requirements for expandable applications or commercial deployments. See the original [Framework notices](apps/client/src/pets/vendor/CUBISM-LICENSE.md) and [official SDK publication information](https://www.live2d.com/en/sdk/license/).

GrayCode 自己的 Live2D 适配代码仍按 AGPL 提供源码。组合例外仅处理已列明的组件，不是所有插件或闭源功能的通用豁免。

## Corresponding Source / 对应源码

Distribution builds identify their exact source commit. `npm run package:source` produces the repository source archive and SHA-256 manifest; `npm run package:desktop` creates this archive before building and includes it with the program. The desktop build workflow uploads the matching source archive alongside its binaries. The source archive includes the lockfiles, build/install scripts, license notices and source revision metadata.

Desktop/Web application information and `/gray source` or `/gray help` expose version-specific source and licensing links. Fork maintainers can set `GRAYCODE_SOURCE_REPOSITORY`, `GRAYCODE_SOURCE_URL` and `GRAYCODE_LICENSE_URL` when building, so their users receive their actual modified source. Distributors must make the matching source available alongside downloads and maintain the applicable third-party source, notice and relinking obligations listed in THIRD_PARTY_NOTICES; a CI artifact's expiry does not remove those obligations.

Source archives do not grant permission to include user data or credentials. Public packages are built from clean tracked source; local development builds are identified separately.

## Contributions / 贡献

Contributors retain their copyright. Contributions to the default scope are accepted under AGPL-3.0-only with the Cubism exception above, to the extent the contributor has the right to grant both. Third-party contributions keep their declared original terms. Use the source declaration described in [CONTRIBUTING.md](CONTRIBUTING.md); it is not a copyright assignment or a blanket authorization for proprietary relicensing.

The English license texts control the permissions they grant. The Chinese explanations help readers understand the project policy without replacing the underlying license texts.
