import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
/** 只发布构建后的界面目录，不将项目源码或数据目录作为静态资源根目录。 */
export async function serveWebAsset(directory: string, pathname: string, response: ServerResponse): Promise<boolean> {
  let file: string;
  try {
    const root = await realpath(directory);
    file = await realpath(path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`));
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
    if (!(await stat(file)).isFile()) return false;
  } catch { return false; }
  response.setHeader('Content-Type', contentTypes[path.extname(file)] ?? 'application/octet-stream');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  response.end(await readFile(file));
  return true;
}
