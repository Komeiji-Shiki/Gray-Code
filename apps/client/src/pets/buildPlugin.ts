import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** 单独构建经典脚本，隔离页面不需要放开同源权限来导入 ES 模块。 */
export function petRendererBuild(): Plugin {
  let bundle: Promise<string> | undefined;
  const compile = () => bundle ??= build({ entryPoints: [fileURLToPath(new URL('./renderer.ts', import.meta.url))], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' }).then(result => result.outputFiles[0]!.text);
  return { name: 'graycode-pet-renderer',
    async generateBundle() { this.emitFile({ type: 'asset', fileName: 'pet-renderer.js', source: await compile() }); },
    configureServer(server) {
      server.middlewares.use('/pet-renderer.js', async (_request, response) => {
        try { response.setHeader('Content-Type', 'text/javascript'); response.end(await compile()); }
        catch (error) { response.statusCode = 500; response.end(String(error)); }
      });
    },
  };
}
