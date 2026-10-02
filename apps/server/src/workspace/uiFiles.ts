import { workspaceFilePath } from './paths';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { open, stat } from 'node:fs/promises';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { BINARY_FILE_EXTENSIONS, inferMimeTypeByPath, isLikelyTextFile } from '../../../../backend/tools/shared/inputFileTypes';

export async function uiWorkspace(app: PlatformApplication, client: ClientSession, selected: WorkspaceDefinition | undefined, data: Record<string, any>, write = false) {
  const conversation = data.conversationId ? await app.conversation(client.actorId, data.conversationId) : null;
  const id = conversation ? conversation.workspaceId : selected?.id;
  if (typeof id !== 'string') throw new Error('请先选择工作区。');
  return app.workspace(client.actorId, id, [write ? 'workspace_write' : 'workspace_read']);
}
export function uiFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少文件路径。');
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}
const excluded = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.vscode', '.idea', '__pycache__', '.cache', 'coverage']);

/**
 * 输入框文件搜索每个客户端只保留一次在途请求。界面请求按客户端串行，旧遍历不退出新查询只能排队，
 * 前端又会丢弃迟到的结果，所以新查询到达时立即中止旧的；相同查询在 reusable 确认上下文未变时复用同一结果。
 */
export class WorkspaceFileSearches {
  private readonly flights = new Map<string, { key: string; controller: AbortController; promise: Promise<unknown> }>();
  run(owner: string, key: string, start: (signal: AbortSignal) => Promise<unknown>,
    reusable: (running: Promise<unknown>) => boolean = () => true): Promise<unknown> {
    const current = this.flights.get(owner);
    if (current && current.key === key && reusable(current.promise)) return current.promise;
    current?.controller.abort();
    const controller = new AbortController();
    const flight = { key, controller, promise: start(controller.signal) };
    this.flights.set(owner, flight);
    // 结束后立即释放，表里只有在途搜索；失败由调用方处理，这里只是不让清理链产生未处理拒绝。
    void flight.promise.then(() => undefined, () => undefined).then(() => { if (this.flights.get(owner) === flight) this.flights.delete(owner); });
    return flight.promise;
  }
}

/** 合并判断用的查询键，与处理器对查询的规范化保持一致。 */
export function workspaceFileSearchKey(data: Record<string, any>): string {
  return JSON.stringify([typeof data.query === 'string' ? data.query.trim().toLowerCase() : '', data.limit ?? null, data.conversationId ?? null]);
}

export function inputFileHandlers(app: PlatformApplication, client: ClientSession, selected?: WorkspaceDefinition, signal?: AbortSignal) {
  const workspace = (data: Record<string, any>) => uiWorkspace(app, client, selected, data);
  async function resolve(data: Record<string, any>, value: unknown) {
    const target = await workspace(data); const absolute = await app.files.resolve(target, uiFilePath(value));
    return { target, absolute, relative: workspaceFilePath(target, absolute) };
  }
  async function read(data: Record<string, any>, textOnly: boolean, imageOnly = false) {
    const file = await resolve(data, data.path ?? data.uri);
    const handle = await open(file.absolute, 'r');
    try {
      const info = await handle.stat(); const ext = path.extname(file.relative).toLowerCase();
      const limit = textOnly || !BINARY_FILE_EXTENSIONS.has(ext) ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (!info.isFile() || info.size > limit) throw new Error(`文件超过 ${limit / 1024 / 1024} MiB 或不是普通文件。`);
      const bytes = await handle.readFile(); if (bytes.length > limit) throw new Error('文件读取期间超过大小限制。');
      const mimeType = inferMimeTypeByPath(file.relative);
      if (imageOnly) {
        if (!mimeType.startsWith('image/')) throw new Error('不是支持的图片格式。');
        return { success: true, data: bytes.toString('base64'), mimeType };
      }
      const isText = isLikelyTextFile(file.relative, bytes);
      if (isText) return { success: true, path: file.relative, isText: true, content: bytes.toString('utf8') };
      if (textOnly) throw new Error('此文件不是文本文件。');
      return { success: true, path: file.relative, isText: false, attachment: { name: path.basename(file.relative), size: bytes.length, mimeType, data: bytes.toString('base64') } };
    } finally { await handle.close(); }
  }
  return {
    readFileForContext: (data: Record<string, any>) => read(data, true),
    readWorkspaceTextFile: (data: Record<string, any>) => read(data, true),
    readWorkspaceFileForInput: (data: Record<string, any>) => read(data, false),
    readWorkspaceImage: (data: Record<string, any>) => read(data, false, true),
    getRelativePath: async (data: Record<string, any>) => { const file = await resolve(data, data.absolutePath); return { relativePath: file.relative, isDirectory: (await stat(file.absolute)).isDirectory(), workspaceUri: pathToFileURL(file.target.directory).toString() }; },
    checkWorkspaceFilesExist: async (data: Record<string, any>) => {
      if (!Array.isArray(data.paths)) return { results: {} };
      const results: Record<string, boolean> = {};
      for (const value of data.paths) {
        if (typeof value !== 'string') continue;
        try { const file = await resolve(data, value); results[value] = (await stat(file.absolute)).isFile(); } catch { results[value] = false; }
      }
      return { results };
    },
    searchWorkspaceFiles: async (data: Record<string, any>) => {
      if (!selected && !data.conversationId) return { files: [], activeFilePath: null };
      const target = await workspace(data); signal?.throwIfAborted(); const query = typeof data.query === 'string' ? data.query.trim().toLowerCase() : '';
      const limit = Number.isFinite(data.limit) ? Math.min(200, Math.max(1, Math.floor(data.limit))) : 50;
      const editor = app.files.editorContext(client.clientId, target);
      const opened = editor.openFiles; const activeFilePath = editor.activeFile ?? null;
      const files: { path: string; name: string; isDirectory: boolean; isOpen?: boolean }[] = [];
      const added = new Set<string>();
      if (!query) for (const file of [...opened].reverse()) {
        if (files.length >= limit) break; added.add(file); files.push({ path: file, name: path.basename(file), isDirectory: false, isOpen: true });
      }
      const pending = ['.'];
      while (pending.length && files.length < limit) {
        // 无匹配的查询会扫完整个工作区；被新查询取代后在下一个目录前退出，已发出的单次列目录仍会完成。
        signal?.throwIfAborted();
        const directory = pending.shift()!;
        let entries; try { entries = await app.files.list(target, directory); } catch { continue; }
        for (const entry of entries) {
          if (entry.kind === 'symlink' || excluded.has(entry.name.toLowerCase())) continue;
          if (entry.kind === 'directory') pending.push(entry.path);
          if (added.has(entry.path) || !entry.path.toLowerCase().includes(query)) continue;
          added.add(entry.path); files.push({ path: entry.path, name: entry.name, isDirectory: entry.kind === 'directory', isOpen: opened.includes(entry.path) });
          if (files.length >= limit) break;
        }
      }
      if (query) files.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.length - b.path.length);
      return { files, activeFilePath };
    },
  };
}
