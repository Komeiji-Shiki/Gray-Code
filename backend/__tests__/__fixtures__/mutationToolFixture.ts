import path from 'node:path';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { RuntimeTool, ToolContext } from '../../../packages/core/src/runtime/tools';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { mutationTools } from '../../../apps/server/src/workspace/mutationTools';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { TEMP_DIR_REMOVE_OPTIONS } from './tempDirectory';

/** 实际文件事务负责读取与编码，测试只控制用户审阅返回的终态。 */
export function createMutationToolFixture(name: string) {
    const propose = jest.fn();
    let directory: string;
    let context: ToolContext;
    let tool: RuntimeTool;
    const fixture = {
        propose,
        get tool() { return tool; },
        async reset(content: string) {
            const root = path.resolve('.tmp');
            await mkdir(root, { recursive: true });
            directory = await mkdtemp(path.join(root, 'file-terminal-'));
            context = { actorId: 'owner', runId: name, conversationId: 'file-terminal', toolCallId: 'tool-1',
                workspace: { id: 'project', name: 'project', directory, deviceId: 'local' },
                signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
            const app = { files: new WorkspaceFiles(), diffs: { propose } } as unknown as PlatformApplication;
            tool = mutationTools(app, 'unified').find(item => item.declaration.name === name)!;
            propose.mockReset().mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });
            await fixture.setContent(content);
        },
        async restore() {
            // directory 只来自当前工作区 .tmp 下的 mkdtemp，清理范围为本夹具创建的目录。
            await rm(directory, TEMP_DIR_REMOVE_OPTIONS);
        },
        async setContent(content: string | null) {
            const file = path.join(directory, 'sample.ts');
            if (content === null) await rm(file, { force: true });
            else await writeFile(file, content);
        },
        async exists() {
            try { await stat(path.join(directory, 'sample.ts')); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
        },
        async run(args: Record<string, unknown>): Promise<any> {
            return tool.execute(args, context);
        }
    };
    return fixture;
}
