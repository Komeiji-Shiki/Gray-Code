import * as fs from 'fs/promises';
import * as path from 'path';

import { CheckpointBackupExecutor } from '../../modules/checkpoint/CheckpointBackupExecutor';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath
} from '../../modules/checkpoint/CheckpointWorkspace';
import { createTempDirectory } from '../__fixtures__/checkpointFixtures';

describe('CheckpointBackupExecutor', () => {
    test('拒绝复制符号链接路径，不跟随链接目标', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp-copy-symlink-workspace-');
        const outsideRoot = await createTempDirectory('limcode-cp-copy-symlink-outside-');
        const backupRoot = await createTempDirectory('limcode-cp-copy-symlink-backup-');
        try {
            const outsideFile = path.join(outsideRoot, 'secret.txt');
            const linkPath = path.join(workspaceRoot, 'link.txt');
            await fs.writeFile(outsideFile, 'outside content', 'utf-8');
            try {
                await fs.symlink(outsideFile, linkPath, 'file');
            } catch {
                // Windows 未开启开发者模式/链接权限时跳过，不把环境能力差异当成产品失败。
                return;
            }

            const roots = createRuntimeWorkspaceRoots([{
                name: 'root',
                uri: `file:///${workspaceRoot.replace(/\\/g, '/')}`,
                fsPath: workspaceRoot
            }]);
            const scopedPath = createWorkspaceScopedPath(roots[0].id, 'link.txt');
            const executor = new CheckpointBackupExecutor({} as never);
            const result = await (executor as any).copyFileToBackup(
                scopedPath,
                backupRoot,
                roots,
                undefined
            );

            expect(result.ok).toBe(false);
            await expect(fs.access(path.join(backupRoot, roots[0].id, 'link.txt'))).rejects.toThrow();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(outsideRoot, { recursive: true, force: true });
            await fs.rm(backupRoot, { recursive: true, force: true });
        }
    });
});
