# 桌宠播放器第三方来源

- `cubism4.js` 和 `cubism4.d.ts`：`pixi-live2d-display` 0.4.0 的发布文件，保持原样。仅保留 Cubism 4 播放模块，不引入原包的网站发布命令依赖。
- 该模块包含 Cubism Web Framework。原项目 v0.4.0 的 `cubism` 子模块固定到 `guansss/CubismWebFramework` 提交 `1f9cdfd140e87ba0ae68a356bb5ec339a0e65f99`，`CUBISM-LICENSE.md` 来自该提交。
- 包装器自己的 MIT 许可保存在 `LICENSE`；框架部分适用 Live2D Open Software License，不能视为 GrayCode 根目录项目许可的一部分。取得和使用框架须遵守其许可及发行条件。
- 文件 SHA-256、版本和来源保存在 `provenance.json`。成品程序中的“播放器与框架许可”显示 `public/pets-notices.txt`。
- 不附带 Cubism Core、模型或用户图集。Core 由使用者从官方 SDK 获得并本地导入，素材使用许可单独保留在资源信息中。
- GrayCode 自有适配代码采用 AGPL-3.0-only，组合时适用根目录 `LICENSES/GrayCode-Cubism-exception.txt` 的限定许可。该例外不改变这里的第三方授权，也不代表已经取得 Live2D 的发行许可。

播放器采用 `model3.json` 的 Cubism 3/4 加载流程。[独立颜色适配器](../cubismCompatibility.ts) 继承发布文件中的 renderer 和 shader，读取 Core 的 Drawable 乘算色与屏幕色，并按[官方 5-r.4 的预乘透明度公式](https://github.com/Live2D/CubismWebFramework/blob/5-r.4/src/rendering/cubismshader_webgl.ts) 处理普通、带掩码和反向掩码绘制。适配器为每个播放器实例独立管理 shader，掩码生成继续只计算透明度，第三方发布文件与来源摘要保持原样。

[官方 4.2 兼容说明](https://docs.live2d.com/en/cubism-sdk-manual/compatibility-with-cubism-4-2/) 明确：BlendShape 通过标准参数接口使用，形变由 Core 更新。播放器继续把全部参数交给 Core 的 `model.update()`；诊断结果从实际 `parameters.types` 读取 BlendShape 参数，并显示 Core 颜色与 GPU uniform，以供真实素材验证。
