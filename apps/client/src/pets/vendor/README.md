# 桌宠播放器第三方来源

- `cubism4.js` 和 `cubism4.d.ts`：`pixi-live2d-display` 0.4.0 的发布文件，保持原样。仅保留 Cubism 4 播放模块，不引入原包的网站发布命令依赖。
- 该模块包含 Cubism Web Framework。原项目 v0.4.0 的 `cubism` 子模块固定到 `guansss/CubismWebFramework` 提交 `1f9cdfd140e87ba0ae68a356bb5ec339a0e65f99`，`CUBISM-LICENSE.md` 来自该提交。
- 包装器自己的 MIT 许可保存在 `LICENSE`；框架部分适用 Live2D Open Software License，不能视为 GrayCode 根目录 MIT 许可的一部分。取得和使用框架须遵守其许可及发行条件。
- 文件 SHA-256、版本和来源保存在 `provenance.json`。成品程序中的“播放器与框架许可”显示 `public/pets-notices.txt`。
- 不附带 Cubism Core、模型或用户图集。Core 由使用者从官方 SDK 获得并本地导入，素材使用许可单独保留在资源信息中。

播放器采用 `model3.json` 的 Cubism 3/4 流程；实际验证过本地 Core 5.2 与官方 Haru 样本，不把这一结果扩展为所有 Cubism 5 特性的兼容性保证。
