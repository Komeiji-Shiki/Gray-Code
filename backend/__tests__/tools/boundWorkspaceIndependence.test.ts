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

/**
 * 同名嵌套目录（zip/7z 双解压，proj/proj/...）回归测试：
 * 工作区根下存在与工作区同名的真实目录时，parseWorkspacePath 不得剥离首段前缀，
 * 否则索引里显示的 proj/README.md 会被解析到根下的 README.md（错位一层，读写全部 ENOENT）。
 */
describe('nested same-name workspace folder (zip/7z double-extraction)', () => {
    let nestedRoot: string;
    let cleanupDirs: string[] = [];

    const fileUriString = (fsPath: string): string =>
        'file://' + fsPath.replace(/\\/g, '/');

    beforeEach(() => {
        const wsName = `gc-nested-${Date.now()}`;
        // 工作区根 + 同名内层目录：<tmp>/gc-nested-XXX/gc-nested-XXX/
        nestedRoot = path.join(os.tmpdir(), wsName);
        const inner = path.join(nestedRoot, wsName);
        fs.mkdirSync(path.join(inner, 'app'), { recursive: true });
        fs.writeFileSync(path.join(inner, 'README.md'), 'nested readme', 'utf-8');
        fs.writeFileSync(path.join(inner, 'app', 'bot.py'), 'print(1)', 'utf-8');
        // 第三层同名嵌套：<tmp>/gc-nested-XXX/gc-nested-XXX/gc-nested-XXX/file.txt
        fs.mkdirSync(path.join(inner, wsName), { recursive: true });
        fs.writeFileSync(path.join(inner, wsName, 'file.txt'), 'deep', 'utf-8');
        cleanupDirs = [nestedRoot];

        (vscode.workspace as any).workspaceFolders = [{
            name: path.basename(nestedRoot),
            uri: vscode.Uri.file(nestedRoot)
        }];
    });

    afterEach(() => {
        for (const dir of cleanupDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        (vscode.workspace as any).workspaceFolders = [];
    });

    const boundUri = (): string => fileUriString(nestedRoot);
    const wsName = (): string => path.basename(nestedRoot);

    it('双层同名嵌套：索引显示的 proj/README.md 按真实路径解析（不再错位剥离）', () => {
        const parsed = parseWorkspacePath(`${wsName()}/README.md`, boundUri());

        expect(parsed.workspace?.fsPath).toBe(nestedRoot);
        // 首段是真实目录，前缀不被剥离
        expect(parsed.relativePath).toBe(`${wsName()}/README.md`);

        const resolved = resolveFileToolPathWithInfo(`${wsName()}/README.md`, boundUri());
        expect(resolved.uri?.fsPath).toBe(path.join(nestedRoot, wsName(), 'README.md'));
        expect(resolved.isOutsideWorkspace).toBe(false);
    });

    it('双层同名嵌套：写入路径同样解析到内层目录', () => {
        const resolved = resolveFileToolPathWithInfo(`${wsName()}/app/bot.py`, boundUri());

        expect(resolved.uri?.fsPath).toBe(path.join(nestedRoot, wsName(), 'app', 'bot.py'));
        expect(resolved.relativePath).toBe(`${wsName()}/app/bot.py`);
    });

    it('多层同名嵌套（proj/proj/proj/file.txt）：索引路径按原样逐层解析', () => {
        const parsed = parseWorkspacePath(`${wsName()}/${wsName()}/file.txt`, boundUri());

        expect(parsed.workspace?.fsPath).toBe(nestedRoot);
        expect(parsed.relativePath).toBe(`${wsName()}/${wsName()}/file.txt`);

        const resolved = resolveFileToolPathWithInfo(`${wsName()}/${wsName()}/file.txt`, boundUri());
        expect(resolved.uri?.fsPath).toBe(path.join(nestedRoot, wsName(), wsName(), 'file.txt'));
    });

    it('路径仅等于工作区名时解析到同名嵌套目录本身', () => {
        const parsed = parseWorkspacePath(wsName(), boundUri());

        expect(parsed.workspace?.fsPath).toBe(nestedRoot);
        expect(parsed.relativePath).toBe(wsName());
        expect(parsed.isExplicit).toBe(true);
    });

    it('同名嵌套目录不存在时仍按工作区前缀剥离（原行为不回归）', () => {
        const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-plain-'));
        cleanupDirs.push(plainRoot);
        fs.mkdirSync(path.join(plainRoot, 'app'), { recursive: true });
        fs.writeFileSync(path.join(plainRoot, 'app', 'bot.py'), 'print(1)', 'utf-8');

        const parsed = parseWorkspacePath(`${path.basename(plainRoot)}/app/bot.py`, fileUriString(plainRoot));

        expect(parsed.workspace?.fsPath).toBe(plainRoot);
        expect(parsed.relativePath).toBe('app/bot.py');
    });
});
