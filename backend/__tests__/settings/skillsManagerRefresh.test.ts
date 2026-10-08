/**
 * SkillsManager.refresh 回归测试：
 * refresh 清空并重扫 skills 后，应基于新扫描结果重建 enabledSkillIds——
 * 磁盘上已删除的 skill 不再视为启用，仍存在的 skill 保留启用状态。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SkillsManager } from '../../modules/skills/SkillsManager';
import { SkillsRuntime } from '../../modules/skills/SkillsRuntime';
import { TEMP_DIR_REMOVE_OPTIONS } from '../__fixtures__/tempDirectory';

function writeSkill(dir: string, id: string, description = 'test skill'): string {
    const skillDir = path.join(dir, id);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(
        skillFile,
        `---\nname: ${id}\ndescription: ${description}\n---\n\nbody of ${id}\n`,
        'utf-8'
    );
    return skillFile;
}

describe('SkillsManager.refresh', () => {
    let root: string;
    let workspacePath: string;
    let projectSkills: string;
    let manager: SkillsManager;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-refresh-'));
        workspacePath = path.join(root, 'workspace');
        fs.mkdirSync(workspacePath, { recursive: true });
        projectSkills = path.join(workspacePath, '.graycode', 'skills');
        manager = new SkillsManager({ workspacePath, globalStoragePath: path.join(root, 'global') });
    });

    afterEach(() => {
        fs.rmSync(root, TEMP_DIR_REMOVE_OPTIONS);
    });

    test('refresh 后已删除的 skill 不再视为启用，仍存在的保留启用状态', async () => {
        writeSkill(projectSkills, 'foo');
        writeSkill(projectSkills, 'bar');

        await manager.refresh();
        expect(manager.getSkill('foo')).toBeDefined();
        expect(manager.getSkill('bar')).toBeDefined();

        expect(manager.enableSkill('foo')).toBe(true);
        expect(manager.enableSkill('bar')).toBe(true);
        expect(manager.isSkillEnabled('foo')).toBe(true);
        expect(manager.isSkillEnabled('bar')).toBe(true);

        // 磁盘删除 bar 后 refresh
        fs.rmSync(path.join(projectSkills, 'bar'), TEMP_DIR_REMOVE_OPTIONS);
        await manager.refresh();

        expect(manager.getSkill('bar')).toBeUndefined();
        expect(manager.isSkillEnabled('bar')).toBe(false);
        // 仍存在的 skill 保留启用状态
        expect(manager.getSkill('foo')).toBeDefined();
        expect(manager.isSkillEnabled('foo')).toBe(true);
    });

    test('任务取消会中断技能读取，并保留上一份完整目录与启用状态', async () => {
        writeSkill(projectSkills, 'foo');
        const controller = new AbortController();
        const scanner = new SkillsRuntime({ workspacePath, globalStoragePath: path.join(root, 'global'),
            includeUserSkills: false, signal: controller.signal });
        await scanner.refresh();
        scanner.enableSkill('foo');
        const previous = scanner.getSkill('foo');
        let entered!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        let release = () => {};
        let receivedSignal: AbortSignal | undefined;
        const read = jest.spyOn(fs.promises, 'readFile').mockImplementationOnce(async (_file, options) => {
            receivedSignal = typeof options === 'object' && options ? options.signal : undefined;
            return new Promise<string>((resolve, reject) => {
                const abort = () => reject(receivedSignal!.reason);
                receivedSignal?.addEventListener('abort', abort, { once: true });
                release = () => { receivedSignal?.removeEventListener('abort', abort); resolve(''); };
                entered();
            });
        });
        const outcome = scanner.refresh().then(() => undefined, error => error);
        try {
            await reading;
            expect(receivedSignal).toBe(controller.signal);
            const reason = new Error('停止技能扫描');
            controller.abort(reason);
            expect(await outcome).toBe(reason);
            expect(scanner.getSkill('foo')).toEqual(previous);
            expect(scanner.isSkillEnabled('foo')).toBe(true);
        } finally {
            release();
            await outcome;
            read.mockRestore();
        }
    });

    test('refresh 不影响未启用 skill 的状态', async () => {
        writeSkill(projectSkills, 'foo');
        writeSkill(projectSkills, 'bar');

        await manager.refresh();
        expect(manager.enableSkill('foo')).toBe(true);

        await manager.refresh();

        expect(manager.isSkillEnabled('foo')).toBe(true);
        expect(manager.isSkillEnabled('bar')).toBe(false);
    });
});
