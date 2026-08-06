import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveFileToolPathWithInfo, parseWorkspacePath } from '../../tools/utils';

/**
 * 对话绑定工作区独立（多工作区）回归测试：
 * 桌面版切换打开的工作区后，绑定工作区会从 workspaceFolders 移除（“已关闭”），
 * 但对话的工具路径仍必须解析到原绑定工作区，而不是回落到当前打开的工作区。
 */
describe('bound workspace independence (closed bound workspace)', () => {
    let openRoot: string;
    let boundRoot: string;
    let cleanupDirs: string[] = [];

    const fileUriString = (fsPath: string): string =>
        'file://' + fsPath.replace(/\\/g, '/');

    beforeEach(() => {
        openRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-open-'));
        boundRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bound-'));
        cleanupDirs = [openRoot, boundRoot];
        fs.mkdirSync(path.join(boundRoot, 'app'), { recursive: true });
        fs.writeFileSync(path.join(boundRoot, 'README.md'), 'bound readme', 'utf-8');
        fs.writeFileSync(path.join(boundRoot, 'app', 'bot.py'), 'print(1)', 'utf-8');
        fs.writeFileSync(path.join(openRoot, 'only-one.html'), 'html', 'utf-8');

        // 当前打开的工作区：只有 openRoot（桌面版单工作区形态），绑定工作区不在其中
        (vscode.workspace as any).workspaceFolders = [{
            name: path.basename(openRoot),
            uri: vscode.Uri.file(openRoot)
        }];
    });

    afterEach(() => {
        for (const dir of cleanupDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        (vscode.workspace as any).workspaceFolders = [];
    });

    const boundUri = (): string => fileUriString(boundRoot);

    it('相对路径解析到已关闭的绑定工作区而不是当前打开的工作区', () => {
        const resolved = resolveFileToolPathWithInfo('app/bot.py', boundUri());

        expect(resolved.uri?.fsPath).toBe(path.join(boundRoot, 'app', 'bot.py'));
        expect(resolved.isOutsideWorkspace).toBe(false);
        expect(resolved.workspace?.fsPath).toBe(boundRoot);
        expect(resolved.relativePath).toBe('app/bot.py');
    });

    it('绑定工作区内绝对路径标记为工作区文件', () => {
        const absReadme = path.join(boundRoot, 'README.md');
        const resolved = resolveFileToolPathWithInfo(absReadme, boundUri());

        expect(resolved.isOutsideWorkspace).toBe(false);
        expect(resolved.workspace?.fsPath).toBe(boundRoot);
        expect(resolved.relativePath).toBe('README.md');
    });

    it('当前打开工作区内的绝对路径仍归属打开的工作区', () => {
        const absHtml = path.join(openRoot, 'only-one.html');
        const resolved = resolveFileToolPathWithInfo(absHtml, boundUri());

        expect(resolved.isOutsideWorkspace).toBe(false);
        expect(resolved.workspace?.fsPath).toBe(openRoot);
    });

    it('绑定工作区外的绝对路径仍标记为工作区外', () => {
        const outside = path.join(os.tmpdir(), `gc-outside-${Date.now()}.txt`);
        fs.writeFileSync(outside, 'x', 'utf-8');
        cleanupDirs.push(outside);
        const resolved = resolveFileToolPathWithInfo(outside, boundUri());

        expect(resolved.isOutsideWorkspace).toBe(true);
    });

    it('以绑定工作区名为前缀的路径剥离前缀后解析', () => {
        const parsed = parseWorkspacePath(
            `${path.basename(boundRoot)}/app/bot.py`,
            boundUri()
        );

        expect(parsed.workspace?.fsPath).toBe(boundRoot);
        expect(parsed.relativePath).toBe('app/bot.py');
        expect(parsed.isExplicit).toBe(true);
    });

    it('绑定工作区目录被删除后回退当前打开工作区', () => {
        const deadRoot = path.join(os.tmpdir(), `gc-dead-${Date.now()}`);
        fs.mkdirSync(deadRoot, { recursive: true });
        const deadUri = fileUriString(deadRoot);
        fs.rmSync(deadRoot, { recursive: true, force: true });

        const resolved = resolveFileToolPathWithInfo('src/index.ts', deadUri);

        expect(resolved.uri?.fsPath).toBe(path.join(openRoot, 'src', 'index.ts'));
        expect(resolved.workspace?.fsPath).toBe(openRoot);
    });
});
