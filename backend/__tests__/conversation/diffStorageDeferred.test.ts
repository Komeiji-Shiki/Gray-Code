import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DiffStorageManager } from '../../modules/conversation/DiffStorageManager';

describe('DiffStorageManager deferred global diff persistence', () => {
    let tempDir: string;
    let manager: DiffStorageManager;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'graycode-diff-cache-'));
        manager = DiffStorageManager.initialize(tempDir);
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('deferred 保存立即提供内存预览，并在后台写入紧凑 JSON', async () => {
        const ref = manager.saveGlobalDiffDeferred({
            originalContent: 'before\n',
            newContent: 'after\n',
            filePath: 'src/example.ts'
        }, 'diff_deferred_test');

        expect(ref.diffId).toBe('diff_deferred_test');
        await expect(manager.loadGlobalDiff(ref.diffId)).resolves.toMatchObject({
            originalContent: 'before\n',
            newContent: 'after\n',
            filePath: 'src/example.ts'
        });

        const persistedPath = path.join(tempDir, 'diffs', '__global__', 'diff_deferred_test.json');
        let persisted = '';
        for (let i = 0; i < 100; i++) {
            try {
                persisted = await fsp.readFile(persistedPath, 'utf8');
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }

        expect(persisted).not.toBe('');
        expect(JSON.parse(persisted)).toMatchObject({
            originalContent: 'before\n',
            newContent: 'after\n'
        });
        expect(persisted).not.toContain('\n  "originalContent"');
    });
});
