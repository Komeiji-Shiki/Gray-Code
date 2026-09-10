import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UI_FILE_UPLOAD_LIMIT } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';

const encodedName = (name: string) => encodeURIComponent(name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
async function uploadBytes(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length']) > UI_FILE_UPLOAD_LIMIT) throw new Error('单个上传文件不能超过 64 MiB。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; if (size > UI_FILE_UPLOAD_LIMIT) throw new Error('单个上传文件不能超过 64 MiB。'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 文件内容使用原始字节传输，避免把大附件转换成 RPC 的 JSON 字符串。 */
export async function serveWorkspaceFile(app: PlatformApplication, auth: { client: ClientSession; valid(): boolean }, url: URL,
  request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const route = /^\/files\/(upload|download|content)\/([^/]+)$/.exec(url.pathname);
  if (!route) return false;
  app.requireOwner(auth.client.actorId);
  const workspaceId = decodeURIComponent(route[2]); const file = url.searchParams.get('path') ?? '';
  if (route[1] === 'upload' && request.method === 'POST') {
    const version = request.headers['x-graycode-file-version'];
    if (typeof version !== 'string') throw new Error('上传前请先取得目标路径的版本。');
    const workspace = app.workspace(auth.client.actorId, workspaceId, ['workspace_write']);
    const absolute = await app.files.resolveEntry(workspace, file);
    app.files.assertCleanEntries(absolute, app.settings.snapshot().settings.workspaces);
    const bytes = await uploadBytes(request);
    if (!auth.valid()) { response.writeHead(401); response.end(JSON.stringify({ error: '登录已失效，上传未应用。' })); return true; }
    const result = await app.fileActions.upload(auth.client.actorId, workspaceId, file, version, bytes);
    response.end(JSON.stringify({ result })); return true;
  }
  if (route[1] === 'upload' || !['GET', 'HEAD'].includes(request.method ?? '')) throw new Error('文件传输请求方法无效。');
  const fileInfo = await app.fileActions.download(auth.client.actorId, workspaceId, file);
  let start = 0; let end = fileInfo.size - 1; let partial = false;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, fileInfo.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
      partial = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < fileInfo.size;
    }
    if (!partial) { response.writeHead(416, { 'Content-Range': `bytes */${fileInfo.size}` }); response.end(); return true; }
  }
  response.setHeader('Content-Type', route[1] === 'content' ? fileInfo.mimeType : 'application/octet-stream');
  response.setHeader('Content-Disposition', `${route[1] === 'content' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName(fileInfo.name)}`);
  response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'; base-uri 'none'");
  response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', Math.max(0, end - start + 1));
  if (partial) response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileInfo.size}` });
  if (request.method === 'HEAD' || !fileInfo.size) { response.end(); return true; }
  const authorized = new Transform({ transform(chunk, _encoding, callback) {
    if (!auth.valid()) callback(new Error('文件传输期间登录已失效。')); else callback(null, chunk);
  } });
  await pipeline(createReadStream(fileInfo.absolute, { start, end }), authorized, response);
  return true;
}
