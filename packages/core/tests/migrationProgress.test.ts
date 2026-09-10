import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './fixtures';

test('真实 Node 进程中的迁移取消、续传、设置队列与失败状态', async () => {
  const f = await fixture(); await f.store.close();
  try {
    // 与发行程序保持同一运行环境，避免 Jest VM 与 SQLite worker 的原型差异。
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.resolve('packages/core/tests/fixtures/migration-progress.cjs'), f.root],
      { cwd: process.cwd(), windowsHide: true, timeout: 10000 });
    const result = JSON.parse(stdout.trim().split('\n').find(line => line.startsWith('MIGRATION_RESULT '))!.slice(17));
    expect(result).toEqual({ settingsResponsive: true, cancelled: true, resumed: true, failureVisible: true, sourceUnchanged: true });
  } finally { await f.cleanup(); }
});
