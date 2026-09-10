import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './fixtures';

test('迁入项目按实际目录关联工作区，保留检查点与同名项目的区别', async () => {
  const f = await fixture(); await f.store.close();
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.resolve('packages/core/tests/fixtures/project-workspace.cjs'), f.root],
      { cwd: process.cwd(), windowsHide: true, timeout: 10000 });
    const result = JSON.parse(stdout.trim().split('\n').find(line => line.startsWith('PROJECT_RESULT '))!.slice(15));
    expect(result).toEqual({ aliasMatched: true, focusedWorkspace: true, checkpointBound: true, separateProjects: true, missingPathReadable: true });
  } finally { await f.cleanup(); }
});
