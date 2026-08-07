/**
 * WorkspaceManager 单元测试
 *
 * 覆盖 1.7.3「对话绑定工作区锁定 + 下拉切换」修复：
 * - 固定/解除固定（setActiveWorkspaceUri）与激活工作区计算（getActiveWorkspaceUri）
 * - Windows 大小写不敏感匹配：同一目录不同大小写路径视为同一工作区，
 *   固定时使用列表中的规范 URI（修复下拉点击静默失败）
 * - 请求的工作区未打开时不解除现有固定（锁定语义：打开对话不破坏当前固定）
 * - 被固定的工作区关闭时自动回退跟随（list[0]）
 */
import { WorkspaceManager, type WorkspaceFolderInfo } from '../../../webview/utils/WorkspaceManager';
import * as vscode from 'vscode';

const WIN32 = process.platform === 'win32';

function makeFolder(uri: string, fsPath: string, index: number): WorkspaceFolderInfo {
    return {
        name: fsPath.split(/[\\/]/).pop() || fsPath,
        uri,
        fsPath,
        index
    };
}

let onActiveWorkspaceChanged: ((uri: string | null) => void) | null = null;
let onWorkspaceListChanged: ((list: WorkspaceFolderInfo[]) => void) | null = null;

function setFolders(list: WorkspaceFolderInfo[]): void {
    (vscode.workspace as any).workspaceFolders = list;
}

function createManager(): { manager: WorkspaceManager; fireFoldersChanged: () => void } {
    onActiveWorkspaceChanged = null;
    onWorkspaceListChanged = null;
    const manager = new WorkspaceManager({
        onActiveWorkspaceChanged: (uri) => { onActiveWorkspaceChanged?.(uri); },
        onWorkspaceListChanged: (list) => { onWorkspaceListChanged?.(list); }
    });
    // 手动触发 handleChange（测试环境不依赖 vscode 事件发射）
    const fireFoldersChanged = () => (manager as any).handleChange();
    return { manager, fireFoldersChanged };
}

const URI_A = 'file:///c%3A/Users/foo/ProjectA';
const URI_A_DRIFT = 'file:///C%3A/Users/FOO/ProjectA';
const URI_B = 'file:///c%3A/Users/foo/ProjectB';

describe('WorkspaceManager 固定/解除固定', () => {
    let manager: WorkspaceManager;
    let fireFoldersChanged: () => void;

    beforeEach(() => {
        setFolders([makeFolder(URI_A, 'c:\\Users\\foo\\ProjectA', 0)]);
        ({ manager, fireFoldersChanged } = createManager());
    });

    it('默认自动跟随（未固定）', () => {
        expect(manager.isAutoFollow()).toBe(true);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A);
    });

    it('固定工作区后不再自动跟随', () => {
        manager.setActiveWorkspaceUri(URI_A);
        expect(manager.isAutoFollow()).toBe(false);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A);
    });

    it('传 null 解除固定恢复自动跟随', () => {
        manager.setActiveWorkspaceUri(URI_A);
        manager.setActiveWorkspaceUri(null);
        expect(manager.isAutoFollow()).toBe(true);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A);
    });

    it('重复固定同一工作区为幂等', () => {
        manager.setActiveWorkspaceUri(URI_A);
        const before = manager.getActiveWorkspaceUri();
        manager.setActiveWorkspaceUri(URI_A);
        expect(manager.getActiveWorkspaceUri()).toBe(before);
    });
});

describe('WorkspaceManager Windows 大小写不敏感匹配', () => {
    let manager: WorkspaceManager;
    let fireFoldersChanged: () => void;

    beforeEach(() => {
        setFolders([makeFolder(URI_A, 'c:\\Users\\foo\\ProjectA', 0)]);
        ({ manager, fireFoldersChanged } = createManager());
    });

    (WIN32 ? it : it.skip)('大小写漂移 URI 命中列表并固定规范 URI', () => {
        manager.setActiveWorkspaceUri(URI_A_DRIFT);
        expect(manager.isAutoFollow()).toBe(false);
        // 激活工作区返回列表中的规范 URI，而非传入的漂移串
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A);
    });

    it('请求未打开的工作区不解除现有固定（锁定语义）', () => {
        manager.setActiveWorkspaceUri(URI_A);
        expect(manager.isAutoFollow()).toBe(false);
        // 请求一个不在列表中的工作区（如对话绑定但已关闭的目录）：
        // 不能把用户当前的固定状态清掉，固定应保持不变
        manager.setActiveWorkspaceUri(URI_B);
        expect(manager.isAutoFollow()).toBe(false);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A);
    });
});

describe('WorkspaceManager 列表变化', () => {
    let manager: WorkspaceManager;
    let fireFoldersChanged: () => void;

    beforeEach(() => {
        setFolders([makeFolder(URI_A, 'c:\\Users\\foo\\ProjectA', 0)]);
        ({ manager, fireFoldersChanged } = createManager());
    });

    it('被固定的工作区关闭后回退自动跟随（列表首个文件夹）', () => {
        manager.setActiveWorkspaceUri(URI_A);
        // 桌面版打开新文件夹会替换列表：A 关闭，B 打开
        setFolders([makeFolder(URI_B, 'c:\\Users\\foo\\ProjectB', 0)]);
        fireFoldersChanged();
        expect(manager.isAutoFollow()).toBe(true);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_B);
    });

    (WIN32 ? it : it.skip)('列表 URI 大小写变化不误报固定失效', () => {
        manager.setActiveWorkspaceUri(URI_A);
        // 同一目录以不同大小写路径重新打开：固定应保持（视为同一工作区）
        setFolders([makeFolder(URI_A_DRIFT, 'C:\\Users\\FOO\\ProjectA', 0)]);
        fireFoldersChanged();
        expect(manager.isAutoFollow()).toBe(false);
        expect(manager.getActiveWorkspaceUri()).toBe(URI_A_DRIFT);
    });
});
