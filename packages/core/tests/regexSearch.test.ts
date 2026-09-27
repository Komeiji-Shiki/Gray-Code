import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixture } from './fixtures';

test('构建后的正则搜索和替换保持宿主响应，并在取消及应用关闭时释放计算', async () => {
  const f = await fixture(); await f.store.close();
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.resolve('packages/core/tests/fixtures/regex-search.cjs'), f.root],
      { cwd: process.cwd(), windowsHide: true, timeout: 10000 });
    const line = stdout.trim().split('\n').find(value => value.startsWith('REGEX_RESULT '))!;
    expect(JSON.parse(line.slice(13))).toEqual({ searchCancelled: true, toolsCancelled: true, replaceStopped: true, diskUnchanged: true });
  } finally { await f.cleanup(); }
});
