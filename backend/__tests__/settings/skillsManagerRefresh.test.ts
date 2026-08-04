/**
 * SkillsManager.refresh 回归测试：
 * refresh 清空并重扫 skills 后，应基于新扫描结果重建 enabledSkillIds——
 * 磁盘上已删除的 skill 不再视为启用，仍存在的 skill 保留启用状态。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SkillsManager } from '../../modules/skills/SkillsManager';

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
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('refresh 后已删除的 skill 不再视为启用，仍存在的保留启用状态', async () => {
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
        fs.rmSync(path.join(projectSkills, 'bar'), { recursive: true, force: true });
        await manager.refresh();

        expect(manager.getSkill('bar')).toBeUndefined();
        expect(manager.isSkillEnabled('bar')).toBe(false);
        // 仍存在的 skill 保留启用状态
        expect(manager.getSkill('foo')).toBeDefined();
        expect(manager.isSkillEnabled('foo')).toBe(true);
    });

    it('refresh 不影响未启用 skill 的状态', async () => {
        writeSkill(projectSkills, 'foo');
        writeSkill(projectSkills, 'bar');

        await manager.refresh();
        expect(manager.enableSkill('foo')).toBe(true);

        await manager.refresh();

        expect(manager.isSkillEnabled('foo')).toBe(true);
        expect(manager.isSkillEnabled('bar')).toBe(false);
    });
});
