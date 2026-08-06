/**
 * 工作区保存/打开（多工作区收藏）处理器 单元测试
 *
 * 覆盖修复后的关键行为：
 * - saveCurrentWorkspace：无激活工作区报错；有激活工作区加入收藏（await 持久化）
 * - openWorkspaceFolder：目录不存在报错；已打开的工作区直接固定（不重复触发宿主）
 * - openWorkspaceFolder：未打开时经宿主打开并等待列表生效后再响应（避免过期状态）
 * - 收藏持久化在响应前完成（不再 fire-and-forget 丢收藏）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getSavedWorkspaces,
    removeSavedWorkspace,
    saveCurrentWorkspace,
    openWorkspaceFolder,
    SAVED_WORKSPACES_KEY,
} from '../../../webview/handlers/WorkspaceHandlers';
import { setWorkspaceManager } from '../../../webview/utils/WorkspaceManager';
import type { WorkspaceFolderInfo } from '../../../webview/utils/WorkspaceManager';
import type { HandlerContext } from '../../../webview/types';

interface FakeManager {
    getActiveWorkspaceUri: jest.Mock;
    getWorkspaceList: jest.Mock;
    setActiveWorkspaceUri: jest.Mock;
}

function createFakeManager(active: string | null, list: WorkspaceFolderInfo[]): FakeManager {
    return {
        getActiveWorkspaceUri: jest.fn(() => active),
        getWorkspaceList: jest.fn(() => list),
        setActiveWorkspaceUri: jest.fn(),
    };
}

function createCtx(store: Record<string, any>) {
    const responses: Array<{ requestId: string; data: any }> = [];
    const errors: Array<{ requestId: string; code: string; message: string }> = [];
    const ctx = {
        context: {
            globalState: {
                get: jest.fn((key: string) => store[key]),
                update: jest.fn(async (key: string, value: any) => {
                    store[key] = value;
                }),
            },
        },
        sendResponse: jest.fn((requestId: string, data: any) => responses.push({ requestId, data })),
        sendError: jest.fn((requestId: string, code: string, message: string) =>
            errors.push({ requestId, code, message }),
        ),
    };
    return { ctx: ctx as unknown as HandlerContext, responses, errors };
}

describe('WorkspaceHandlers（多工作区保存/打开）', () => {
    let tmpDir: string;
    let store: Record<string, any>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-ws-test-'));
        store = {};
        jest.clearAllMocks();
        setWorkspaceManager(null);
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    });

    afterEach(() => {
        setWorkspaceManager(null);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('getSavedWorkspaces', () => {
        it('返回收藏列表（无收藏时返回空数组）', async () => {
            store[SAVED_WORKSPACES_KEY] = [path.join(tmpDir, 'a')];
            const { ctx, responses } = createCtx(store);
            await getSavedWorkspaces({}, 'r1', ctx);
            expect(responses[0].data.saved.map((w: WorkspaceFolderInfo) => w.fsPath)).toEqual([
                path.join(tmpDir, 'a'),
            ]);
        });
    });

    describe('saveCurrentWorkspace（显式保存工作区）', () => {
        it('无激活工作区时返回 NO_ACTIVE_WORKSPACE 错误', async () => {
            const manager = createFakeManager(null, []);
            setWorkspaceManager(manager as any);
            const { ctx, errors } = createCtx(store);
            await saveCurrentWorkspace({}, 'r1', ctx);
            expect(errors[0].code).toBe('NO_ACTIVE_WORKSPACE');
        });

        it('有激活工作区时加入收藏，且在响应前完成持久化（await）', async () => {
            const fsPath = tmpDir;
            const uri = vscode.Uri.file(fsPath).toString();
            const manager = createFakeManager(uri, [{ name: path.basename(fsPath), uri, fsPath, index: 0 }]);
            setWorkspaceManager(manager as any);
            const { ctx, responses } = createCtx(store);
            await saveCurrentWorkspace({}, 'r1', ctx);
            expect(responses[0].data.success).toBe(true);
            expect(responses[0].data.saved.map((w: WorkspaceFolderInfo) => w.fsPath)).toContain(fsPath);
            // 持久化已完成（update 被调用且值已写入 store）
            expect(store[SAVED_WORKSPACES_KEY]).toContain(fsPath);
        });

        it('重复保存幂等（不产生重复条目）', async () => {
            const fsPath = tmpDir;
            const uri = vscode.Uri.file(fsPath).toString();
            const manager = createFakeManager(uri, [{ name: path.basename(fsPath), uri, fsPath, index: 0 }]);
            setWorkspaceManager(manager as any);
            const { ctx, responses } = createCtx(store);
            await saveCurrentWorkspace({}, 'r1', ctx);
            await saveCurrentWorkspace({}, 'r2', ctx);
            const saved = responses[1].data.saved.map((w: WorkspaceFolderInfo) => w.fsPath);
            expect(saved).toHaveLength(1);
            expect(saved[0]).toBe(fsPath);
        });
    });

    describe('removeSavedWorkspace', () => {
        it('移除指定收藏路径', async () => {
            store[SAVED_WORKSPACES_KEY] = [path.join(tmpDir, 'a'), path.join(tmpDir, 'b')];
            const { ctx, responses } = createCtx(store);
            await removeSavedWorkspace({ fsPath: path.join(tmpDir, 'a') }, 'r1', ctx);
            expect(responses[0].data.saved.map((w: WorkspaceFolderInfo) => w.fsPath)).toEqual([
                path.join(tmpDir, 'b'),
            ]);
            expect(store[SAVED_WORKSPACES_KEY]).toEqual([path.join(tmpDir, 'b')]);
        });
    });

    describe('openWorkspaceFolder（打开工作区）', () => {
        it('指定目录不存在时返回 WORKSPACE_FOLDER_NOT_FOUND 错误', async () => {
            setWorkspaceManager(createFakeManager(null, []) as any);
            const missing = path.join(tmpDir, 'does-not-exist');
            const { ctx, errors } = createCtx(store);
            await openWorkspaceFolder({ fsPath: missing }, 'r1', ctx);
            expect(errors[0].code).toBe('WORKSPACE_FOLDER_NOT_FOUND');
        });

        it('已打开的工作区：直接固定为活动工作区，不重复触发宿主打开', async () => {
            const fsPath = tmpDir;
            const uri = vscode.Uri.file(fsPath).toString();
            const manager = createFakeManager(null, [{ name: path.basename(fsPath), uri, fsPath, index: 0 }]);
            setWorkspaceManager(manager as any);
            const { ctx, responses } = createCtx(store);
            await openWorkspaceFolder({ fsPath }, 'r1', ctx);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.openFolder', expect.anything());
            expect(manager.setActiveWorkspaceUri).toHaveBeenCalledWith(uri);
            expect(responses[0].data.success).toBe(true);
            // 打开即自动加入收藏
            expect(store[SAVED_WORKSPACES_KEY]).toContain(fsPath);
        });

        it('未打开的工作区：经宿主打开，等待列表生效后返回新状态（不返回过期列表）', async () => {
            const fsPath = tmpDir;
            const uri = vscode.Uri.file(fsPath).toString();
            let opened = false;
            const manager: FakeManager = {
                getActiveWorkspaceUri: jest.fn(() => (opened ? uri : null)),
                getWorkspaceList: jest.fn(() =>
                    opened
                        ? [{ name: path.basename(fsPath), uri, fsPath, index: 0 }]
                        : []
                ),
                setActiveWorkspaceUri: jest.fn(),
            };
            (vscode.commands.executeCommand as jest.Mock).mockImplementation(async () => {
                opened = true;
            });
            setWorkspaceManager(manager as any);
            const { ctx, responses } = createCtx(store);
            await openWorkspaceFolder({ fsPath }, 'r1', ctx);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', expect.objectContaining({ fsPath }));
            // 响应包含生效后的工作区列表（不是空列表）
            expect(responses[0].data.workspaces).toHaveLength(1);
            expect(responses[0].data.workspaces[0].fsPath).toBe(fsPath);
            expect(responses[0].data.activeWorkspaceUri).toBe(uri);
            expect(store[SAVED_WORKSPACES_KEY]).toContain(fsPath);
        });

        it('对话框选择路径：选中的文件夹自动加入收藏并打开', async () => {
            const fsPath = tmpDir;
            let opened = false;
            const uri = vscode.Uri.file(fsPath).toString();
            const manager: FakeManager = {
                getActiveWorkspaceUri: jest.fn(() => (opened ? uri : null)),
                getWorkspaceList: jest.fn(() =>
                    opened ? [{ name: path.basename(fsPath), uri, fsPath, index: 0 }] : []
                ),
                setActiveWorkspaceUri: jest.fn(),
            };
            (vscode.commands.executeCommand as jest.Mock).mockImplementation(async () => {
                opened = true;
            });
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([vscode.Uri.file(fsPath)]);
            setWorkspaceManager(manager as any);
            const { ctx, responses } = createCtx(store);
            await openWorkspaceFolder({ fsPath: null }, 'r1', ctx);
            expect(vscode.window.showOpenDialog).toHaveBeenCalled();
            expect(responses[0].data.success).toBe(true);
            expect(store[SAVED_WORKSPACES_KEY]).toContain(fsPath);
        });

        it('对话框取消时返回 canceled 标记且不写收藏', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue(undefined);
            setWorkspaceManager(createFakeManager(null, []) as any);
            const { ctx, responses } = createCtx(store);
            await openWorkspaceFolder({ fsPath: null }, 'r1', ctx);
            expect(responses[0].data).toEqual({ success: false, canceled: true });
            expect(store[SAVED_WORKSPACES_KEY]).toBeUndefined();
        });
    });
});
