import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as iconv from 'iconv-lite';
import type { ToolContext } from '@graycode/core';
import type { RunRecord } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

// 写入工具对非 UTF-8 文件按原编码写回，不能写回时明确拒绝，原文件保持不变。
let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, context: ToolContext;
beforeEach(async () => {
  f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
  const snapshot = app.settings.snapshot();
  snapshot.settings.workspaces.push({ id: 'encoding-workspace', name: 'Fixture', directory: f.root, deviceId: 'local' });
  await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  const now = Date.now();
  await app.storage.createConversation({ id: 'encoding-chat', actorId: 'owner', title: 'encoding', createdAt: now, updatedAt: now });
  const run: RunRecord = { id: 'encoding-run', requestKey: 'encoding-run', actorId: 'owner', agentId: 'default', conversationId: 'encoding-chat', workspaceId: 'encoding-workspace', status: 'queued', iteration: 0, catalogVersion: 'fixture', createdAt: now, updatedAt: now };
  await app.storage.createRun(run, { id: 'encoding-input', role: 'user', parts: [{ text: 'test' }] });
  context = { actorId: 'owner', runId: run.id, conversationId: run.conversationId, toolCallId: 'encoding-call', approvedByToolConfirmation: true,
    workspace: { id: 'encoding-workspace', directory: f.root, name: 'Fixture', deviceId: 'local' },
    signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
});
afterEach(async () => {
  await app.storage.appendRunEvent({ runId: context.runId, type: 'run.cancelled', payload: {}, update: { status: 'cancelled' } });
  await app.close(); await f.cleanup();
});
const tool = (name: string, args: Record<string, unknown>) => app.tools.catalog([name]).entries.get(name)!.tool.execute(args, context) as Promise<any>;
const script = '@echo off\r\nrem 启动游戏并等待退出\r\necho 正在运行\r\n';

test('apply_diff 与 write_file 修改 GBK 文件后仍按 GBK 写回', async () => {
  const file = path.join(f.root, 'run.cmd');
  await writeFile(file, iconv.encode(script, 'gbk'));
  const edited = await tool('apply_diff', { path: 'run.cmd', hunks: [{ oldContent: 'echo 正在运行', newContent: 'echo 运行结束' }] });
  expect(edited).toMatchObject({ success: true, data: { encoding: 'gbk' } });
  const bytes = await readFile(file);
  expect(iconv.decode(bytes, 'gbk')).toBe('@echo off\nrem 启动游戏并等待退出\necho 运行结束\n');
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
  const written = await tool('write_file', { path: 'run.cmd', content: 'rem 重新写入\n' });
  expect(written).toMatchObject({ success: true });
  expect(iconv.decode(await readFile(file), 'gbk')).toBe('rem 重新写入\n');
});

test('新内容含原编码无法表示的字符时拒绝修改，文件保持原样', async () => {
  const file = path.join(f.root, 'run.cmd');
  const original = iconv.encode(script, 'gbk');
  await writeFile(file, original);
  const result = await tool('apply_diff', { path: 'run.cmd', hunks: [{ oldContent: 'echo 正在运行', newContent: 'echo 完成 ✅😀' }] });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).toContain('ENCODING_UNREPRESENTABLE');
  expect(Buffer.compare(await readFile(file), original)).toBe(0);
});

test('UTF-16 文件保留 BOM 与编码；workspace_files 对非 UTF-8 文件给出明确说明', async () => {
  const file = path.join(f.root, 'wide.txt');
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一行\n第二行\n', 'utf16le')]));
  expect(await tool('apply_diff', { path: 'wide.txt', hunks: [{ oldContent: '第二行', newContent: '已修改' }] })).toMatchObject({ success: true });
  const bytes = await readFile(file);
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  expect(bytes.subarray(2).toString('utf16le')).toBe('第一行\n已修改\n');
  await writeFile(path.join(f.root, 'gbk.txt'), iconv.encode('中文内容', 'gbk'));
  await expect(tool('workspace_files', { action: 'read', path: 'gbk.txt' })).rejects.toThrow('ENCODING_NOT_UTF8');
});
