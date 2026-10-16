import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const gzipAsync = promisify(gzip);
const compressibleTypes = new Set(['.html', '.js', '.css', '.json', '.svg']);
/** 只发布构建后的界面目录，不将项目源码或数据目录作为静态资源根目录。 */
export function createWebAssetHandler(directory: string) {
  let resolvedRoot: Promise<string> | undefined;
  return async (pathname: string, request: IncomingMessage, response: ServerResponse, beforeResponse?: () => void): Promise<boolean> => {
    let file: string;
    try {
      // 同一服务实例复用构建根目录；每个文件仍解析真实路径，防止符号链接越出发布范围。
      resolvedRoot ??= realpath(directory).catch(error => { resolvedRoot = undefined; throw error; });
      const root = await resolvedRoot;
      file = await realpath(path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`));
      const relative = path.relative(root, file);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
      if (!(await stat(file)).isFile()) return false;
    } catch { return false; }
    const extension = path.extname(file);
    response.setHeader('Content-Type', contentTypes[extension] ?? 'application/octet-stream');
    // Vite 输出的资源名含内容哈希；HTML 与其他固定入口继续即时获取最新版本。
    if (extension !== '.html' && /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(path.basename(file)))
      response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (pathname === '/pet-renderer.html') {
      response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' blob: 'unsafe-eval'; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob: data:; media-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    } else {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    }
    let bytes: Buffer = await readFile(file);
    if (compressibleTypes.has(extension)) {
      response.setHeader('Vary', 'Accept-Encoding');
      const acceptsGzip = request.headers['accept-encoding']?.split(',').some(value => {
        const [coding, ...parameters] = value.trim().split(';');
        return coding.trim().toLowerCase() === 'gzip' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
      });
      if (acceptsGzip && bytes.byteLength >= 1024) {
        try {
          const compressed = await gzipAsync(bytes, { level: 4 });
          if (compressed.byteLength < bytes.byteLength) { bytes = compressed; response.setHeader('Content-Encoding', 'gzip'); }
        } catch (error) {
          // 压缩是传输优化，失败时仍返回原始构建资源，不影响界面启动。
          console.warn('[Web] 静态资源压缩失败，将返回原始内容：', error);
        }
      }
    }
    response.setHeader('Content-Length', bytes.byteLength);
    beforeResponse?.(); response.end(bytes);
    return true;
  };
}
