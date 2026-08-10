/**
 * ESM → CJS 变换器（jest 自定义 transformer）
 *
 * 仅用于 jsdom 依赖链中的 ESM-only 包（@exodus/bytes、@asamuzakjp/*）：
 * jest-runtime 的模块注册表只支持 CJS，这些包没有 require 条件导出，
 * 直接加载会 SyntaxError。transform 白名单（见 jest.backend.config.js）保证
 * 该变换器绝不触碰业务代码与其他 node_modules 包。
 */
const esbuild = require('esbuild');

module.exports = {
  process(src, filename) {
    try {
      const out = esbuild.transformSync(src, {
        loader: 'js',
        format: 'cjs',
        target: 'node20',
        platform: 'node',
        sourcefile: filename
      });
      return { code: out.code, map: null };
    } catch (err) {
      throw new Error('esm-cjs-transform failed for ' + filename + ': ' + (err && err.message));
    }
  }
};
