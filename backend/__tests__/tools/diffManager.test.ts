import * as fs from 'fs';
import * as vscode from 'vscode';

jest.mock('fs', () => ({
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn(),
    unlinkSync: jest.fn()
}));

jest.mock('../../tools/file/DiffCodeLensProvider', () => {
    const provider = {
        removeSession: jest.fn(),
        getSession: jest.fn(),
        getSessionByFilePath: jest.fn()
    };
    return {
        getDiffCodeLensProvider: () => provider
    };
});

jest.mock('../../core/settingsContext', () => ({
    getGlobalSettingsManager: () => null
}));

jest.mock('../../tools/file/apply_diff', () => ({
    applyDiffToContent: jest.fn()
}));

jest.mock('../../tools/file/unifiedDiff', () => ({
    applyUnifiedDiffHunks: jest.fn()
}));

import { DiffManager, getDiffManager, type PendingDiff } from '../../tools/file/diffManager';
import { fileWriteLockManager } from '../../core/fileWriteLockManager';

type MockTextDocument = {
    uri: { fsPath: string; scheme: string; path: string };
    isDirty: boolean;
    getText: () => string;
    setText: (next: string) => void;
    positionAt: (offset: number) => number;
    save: jest.Mock<Promise<boolean>, []>;
};

class MockWorkspaceEdit {
    public replacements: Array<{ uri: { fsPath: string }; text: string }> = [];

    public replace(uri: { fsPath: string }, _range: unknown, text: string): void {
        this.replacements.push({ uri, text });
    }
}

function resetDiffManagerSingleton(): void {
    const instance = (DiffManager as any).instance as { dispose?: () => void } | null;
    if (instance?.dispose) {
        instance.dispose();
    }
    (DiffManager as any).instance = null;
}

function getManager(): DiffManager {
    return getDiffManager();
}

function createDocument(options?: {
    filePath?: string;
    initialContent?: string;
    saveReturns?: boolean;
}): MockTextDocument {
    const filePath = options?.filePath ?? 'C:/tmp/file.ts';
    let text = options?.initialContent ?? 'original';
    let dirty = false;

    const doc: MockTextDocument = {
        uri: { fsPath: filePath, scheme: 'file', path: filePath },
        get isDirty() {
            return dirty;
        },
        set isDirty(value: boolean) {
            dirty = value;
        },
        getText: () => text,
        setText: (next: string) => {
            text = next;
            dirty = true;
        },
        positionAt: (offset: number) => offset,
        save: jest.fn(async () => {
            if (options?.saveReturns === false) {
                return false;
            }
            dirty = false;
            return true;
        })
    };

    (vscode.workspace as any).textDocuments = [doc];
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(doc);
    return doc;
}

function createPendingDiff(manager: DiffManager, overrides?: Partial<PendingDiff>): PendingDiff {
    const diff: PendingDiff = {
        id: overrides?.id ?? 'diff-1',
        filePath: overrides?.filePath ?? 'src/file.ts',
        absolutePath: overrides?.absolutePath ?? 'C:/tmp/file.ts',
        originalContent: overrides?.originalContent ?? 'original',
        newContent: overrides?.newContent ?? 'accepted',
        timestamp: overrides?.timestamp ?? Date.now(),
        status: overrides?.status ?? 'pending',
        blocks: overrides?.blocks,
        rawDiffs: overrides?.rawDiffs,
        toolId: overrides?.toolId,
        userEditedContent: overrides?.userEditedContent,
        diffGuardWarning: overrides?.diffGuardWarning,
        diffGuardDeletePercent: overrides?.diffGuardDeletePercent,
        conversationId: overrides?.conversationId,
        structuredHunkPlan: overrides?.structuredHunkPlan,
        checkpointReady: overrides?.checkpointReady
    };

    ((manager as any).pendingDiffs as Map<string, PendingDiff>).set(diff.id, diff);
    return diff;
}

/** 冲刷若干轮微任务，让异步动作走到 checkpoint await 或完成收敛 */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function attachListenerDisposables(manager: DiffManager, id: string) {
    const saveDisposable = { dispose: jest.fn() };
    const closeDisposable = { dispose: jest.fn() };

    ((manager as any).saveListeners as Map<string, { dispose: () => void }>).set(id, saveDisposable);
    ((manager as any).closeListeners as Map<string, { dispose: () => void }>).set(id, closeDisposable);

    return { saveDisposable, closeDisposable };
}

describe('DiffManager lifecycle closure', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        resetDiffManagerSingleton();

        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);

        (vscode as any).EventEmitter = class {
            public event = jest.fn();
            public fire = jest.fn();
            public dispose = jest.fn();
        };
        (vscode as any).WorkspaceEdit = MockWorkspaceEdit;
        (vscode as any).Range = jest.fn().mockImplementation((start: unknown, end: unknown) => ({ start, end }));
        (vscode as any).TabInputTextDiff = class {};
        (vscode as any).TextEdit = {
            replace: jest.fn((range: unknown, newText: string) => ({ range, newText }))
        };
        (vscode.Uri as any).parse = (value: string) => ({ fsPath: value, scheme: 'file', path: value });
        (vscode.Uri as any).file = (value: string) => ({ fsPath: value, scheme: 'file', path: value });
        (vscode as any).TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };

        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).registerTextDocumentContentProvider = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).openTextDocument = jest.fn();
        (vscode.workspace as any).applyEdit = jest.fn(async (edit: MockWorkspaceEdit) => {
            const doc = ((vscode.workspace as any).textDocuments as MockTextDocument[])[0];
            const replacement = edit.replacements[0];
            if (doc && replacement && replacement.uri.fsPath === doc.uri.fsPath) {
                doc.setText(replacement.text);
            }
            return true;
        });
        (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onWillSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onDidCloseTextDocument = jest.fn(() => ({ dispose: jest.fn() }));

        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode as any).window = {
            showTextDocument: jest.fn(async () => ({})),
            setStatusBarMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            tabGroups: {
                all: [],
                close: jest.fn(async () => undefined)
            }
        };

        (fs.readFileSync as jest.Mock).mockReturnValue('original');
        (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        resetDiffManagerSingleton();
        // 复位 provider 上残留的 mock 返回值，防止 partial 测试的 getSession.mockReturnValue
        // 泄漏到后续用例（缓存实例跨测试共享，restoreAllMocks 不会清掉 jest.fn 的返回值）
        const provider = require('../../tools/file/DiffCodeLensProvider').getDiffCodeLensProvider();
        (provider.getSession as jest.Mock).mockReset();
        (provider.getSessionByFilePath as jest.Mock).mockReset();
        (provider.removeSession as jest.Mock).mockReset();
    });

    it('opens native tool diff in the main chat column even when Monitor owns another group', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        (vscode.window.tabGroups as any).all = [
            {
                viewColumn: vscode.ViewColumn.One,
                tabs: [{ input: { viewType: 'graycode.subAgentMonitor' } }]
            },
            {
                viewColumn: vscode.ViewColumn.Three,
                tabs: [{ input: { viewType: 'graycode.chatView' } }]
            }
        ];

        const pending = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'changed'
        );

        const diffCall = (vscode.commands.executeCommand as jest.Mock).mock.calls
            .find(call => call[0] === 'vscode.diff');
        expect(diffCall).toBeDefined();
        expect(diffCall[4]).toMatchObject({
            preview: false,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Three
        });

        await manager.rejectDiff(pending.id);
    });

    it('acceptDiff finalizes accepted state and disposes listeners only after persistence succeeds', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        const listeners = attachListenerDisposables(manager, diff.id);

        let statusChanges = 0;
        let saveCompleted = 0;
        manager.addStatusListener(() => {
            statusChanges += 1;
        });
        manager.addSaveCompleteListener(() => {
            saveCompleted += 1;
        });

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(statusChanges).toBe(1);
        expect(saveCompleted).toBe(1);
        expect(listeners.saveDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(listeners.closeDisposable.dispose).toHaveBeenCalledTimes(1);
        expect((manager as any).saveListeners.has(diff.id)).toBe(false);
        expect((manager as any).closeListeners.has(diff.id)).toBe(false);
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
    });

    it('acceptDiff keeps the diff pending and preserves listeners when persistence fails', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: false });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        const listeners = attachListenerDisposables(manager, diff.id);

        (fs.writeFileSync as jest.Mock).mockImplementation(() => {
            throw new Error('disk write failed');
        });

        let statusChanges = 0;
        let saveCompleted = 0;
        manager.addStatusListener(() => {
            statusChanges += 1;
        });
        manager.addSaveCompleteListener(() => {
            saveCompleted += 1;
        });

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(false);
        expect(diff.status).toBe('pending');
        expect(statusChanges).toBe(0);
        expect(saveCompleted).toBe(0);
        expect(listeners.saveDisposable.dispose).not.toHaveBeenCalled();
        expect(listeners.closeDisposable.dispose).not.toHaveBeenCalled();
        expect((manager as any).saveListeners.get(diff.id)).toBe(listeners.saveDisposable);
        expect((manager as any).closeListeners.get(diff.id)).toBe(listeners.closeDisposable);
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
        expect((vscode.window as any).showErrorMessage).toHaveBeenCalled();
    });

    it('rejectDiff finalizes rejected state and disposes listeners on success', async () => {
        const manager = getManager();
        const doc = createDocument({ initialContent: 'accepted', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        const listeners = attachListenerDisposables(manager, diff.id);

        let statusChanges = 0;
        manager.addStatusListener(() => {
            statusChanges += 1;
        });

        const rejected = await manager.rejectDiff(diff.id);

        expect(rejected).toBe(true);
        expect(diff.status).toBe('rejected');
        expect(doc.getText()).toBe('original');
        expect(statusChanges).toBe(1);
        expect(listeners.saveDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(listeners.closeDisposable.dispose).toHaveBeenCalledTimes(1);
        expect((manager as any).saveListeners.has(diff.id)).toBe(false);
        expect((manager as any).closeListeners.has(diff.id)).toBe(false);
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
    });
    it('status change push carries finalized status after accept (auto-apply settles frontend entries)', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);

        let lastFinalized: Array<{ id: string; status: string }> = [];
        manager.addStatusListener((_pending, _allProcessed, finalized) => {
            lastFinalized = finalized ?? [];
        });

        // 自动应用前推送：终态快照不含该 diff
        const pendingBefore = manager.getPendingDiffs();
        expect(pendingBefore.some((d) => d.id === diff.id)).toBe(true);

        const accepted = await manager.acceptDiff(diff.id, false, true);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        // 自动应用后：diff 已从 pending 列表消失，但终态快照必须携带 accepted
        expect(manager.getPendingDiffs().some((d) => d.id === diff.id)).toBe(false);
        expect(lastFinalized.some((f) => f.id === diff.id && f.status === 'accepted')).toBe(true);
    });
    it('status change push carries rejected status after reject', async () => {
        const manager = getManager();
        const doc = createDocument({ initialContent: 'accepted', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);

        let lastFinalized: Array<{ id: string; status: string }> = [];
        manager.addStatusListener((_pending, _allProcessed, finalized) => {
            lastFinalized = finalized ?? [];
        });

        const rejected = await manager.rejectDiff(diff.id);

        expect(rejected).toBe(true);
        expect(lastFinalized.some((f) => f.id === diff.id && f.status === 'rejected')).toBe(true);
    });
    it('acceptDiff records partial and rejectedBlockIndices on partial acceptance', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);

        const lensProvider = require('../../tools/file/DiffCodeLensProvider').getDiffCodeLensProvider();
        // blocks 含：已确认(0)、已拒绝(1)、未处理(2)——用 index 2 区分 rejected 过滤与 !confirmed 过滤
        (lensProvider.getSession as jest.Mock).mockImplementation((id: string) =>
            id === diff.id
                ? {
                      id: diff.id,
                      blocks: [
                          { index: 0, startLine: 1, endLine: 2, confirmed: true },
                          { index: 1, startLine: 3, endLine: 4, rejected: true },
                          { index: 2, startLine: 5, endLine: 6 }
                      ]
                  }
                : undefined
        );

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(diff.partial).toBe(true);
        // 只有 rejected 的块(1)应被收集；未处理的块(2)不算拒绝
        expect(diff.rejectedBlockIndices).toEqual([1]);
        expect((manager as any).saveListeners.has(diff.id)).toBe(false);
    });

    it('acceptDiff without rejected blocks keeps partial unset', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);

        const lensProvider = require('../../tools/file/DiffCodeLensProvider').getDiffCodeLensProvider();
        (lensProvider.getSession as jest.Mock).mockImplementation((id: string) =>
            id === diff.id
                ? {
                      id: diff.id,
                      blocks: [
                          { index: 0, startLine: 1, endLine: 2, confirmed: true }
                      ]
                  }
                : undefined
        );

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(diff.partial).toBeUndefined();
        expect(diff.rejectedBlockIndices).toBeUndefined();
    });

    it('acceptDiff with userEditedContent records partial even without rejected blocks', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);
        (diff as any).userEditedContent = 'user manually edited';

        const lensProvider = require('../../tools/file/DiffCodeLensProvider').getDiffCodeLensProvider();
        // 无任何 rejected 块
        (lensProvider.getSession as jest.Mock).mockImplementation((id: string) =>
            id === diff.id ? { id: diff.id, blocks: [{ index: 0, startLine: 1, endLine: 2, confirmed: true }] } : undefined
        );

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(diff.partial).toBe(true);
        // 无 rejected 块：rejectedBlockIndices 为空数组（partial=true 时总会写入该字段）
        expect(diff.rejectedBlockIndices).toEqual([]);
    });

    it('acceptDiff with partial but no lens session writes empty rejectedBlockIndices', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        attachListenerDisposables(manager, diff.id);
        (diff as any).userEditedContent = 'user manually edited';

        const lensProvider = require('../../tools/file/DiffCodeLensProvider').getDiffCodeLensProvider();
        // lens session 不存在（如 skip-diff-view 路径）→ partial=true 且 rejectedBlockIndices 为空数组
        (lensProvider.getSession as jest.Mock).mockReturnValue(undefined);

        const accepted = await manager.acceptDiff(diff.id, false, false);

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(diff.partial).toBe(true);
        expect(diff.rejectedBlockIndices).toEqual([]);
    });

    it('createPendingDiff keeps the diff pending when opening the diff view fails', async () => {
        const manager = getManager();
        const statusListener = jest.fn();
        manager.addStatusListener(statusListener);

        jest.spyOn(manager as any, 'showDiffView').mockRejectedValue(new Error('open diff failed'));

        const pendingDiff = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'accepted',
            undefined,
            undefined,
            'tool-1'
        );

        expect(pendingDiff.status).toBe('pending');
        expect(manager.getDiff(pendingDiff.id)?.status).toBe('pending');
        expect(statusListener).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalled();
    });

    it('directly saves confirmed tool diffs without scheduling auto-save confirmation', async () => {
        const manager = getManager();
        const statusListener = jest.fn();
        const saveListener = jest.fn();
        manager.addStatusListener(statusListener);
        manager.addSaveCompleteListener(saveListener);
        manager.updateSettings({ autoSave: true, autoSaveDelay: 5000 });

        jest.spyOn(manager as any, 'showDiffView');
        jest.spyOn(manager as any, 'scheduleAutoSave');

        const pendingDiff = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'accepted',
            undefined,
            undefined,
            'tool-1',
            { confirmedByToolConfirmation: true }
        );

        expect(pendingDiff.status).toBe('accepted');
        expect(fs.writeFileSync).toHaveBeenCalledWith('C:/tmp/file.ts', 'accepted', 'utf8');
        expect((manager as any).showDiffView).not.toHaveBeenCalled();
        expect((manager as any).scheduleAutoSave).not.toHaveBeenCalled();
        expect((manager as any).autoSaveTimers.has(pendingDiff.id)).toBe(false);
        expect(statusListener).toHaveBeenCalled();
        expect(saveListener).toHaveBeenCalledWith(pendingDiff);
    });

    it('directApplyAndSave syncs a dirty editor silently without files.revert', async () => {
        const manager = getManager();
        const doc = createDocument({ initialContent: 'original' });
        // 模拟用户在编辑器里的未保存修改（dirty）
        doc.setText('user uncommitted edits');
        expect(doc.isDirty).toBe(true);

        const pendingDiff = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'accepted',
            undefined,
            undefined,
            'tool-1',
            { confirmedByToolConfirmation: true }
        );

        // 磁盘写入 AI 内容
        expect(fs.writeFileSync).toHaveBeenCalledWith('C:/tmp/file.ts', 'accepted', 'utf8');
        // 编辑器内容被静默替换为 AI 内容（而非保留旧缓冲区）
        expect(doc.getText()).toBe('accepted');
        // save 被调用清理 applyEdit 造成的 dirty
        expect(doc.save).toHaveBeenCalled();
        expect(doc.isDirty).toBe(false);
        // 绝不走 files.revert（dirty 时会弹原生确认框阻塞等待链）
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.files.revert', doc.uri);
        // diff 正常收敛为 accepted
        expect(pendingDiff.status).toBe('accepted');
    });

    it('directApplyAndSave still finalizes as accepted when editor sync fails', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original' });
        (vscode.workspace as any).applyEdit = jest.fn(async () => false);

        const pendingDiff = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'accepted',
            undefined,
            undefined,
            'tool-1',
            { confirmedByToolConfirmation: true }
        );

        // 磁盘写入成功即收敛，编辑器同步失败只记录警告
        expect(fs.writeFileSync).toHaveBeenCalledWith('C:/tmp/file.ts', 'accepted', 'utf8');
        expect(pendingDiff.status).toBe('accepted');
        expect(console.warn).toHaveBeenCalled();
    });

    it('auto-save failure finalizes the diff as rejected to unblock tool execution', async () => {
        jest.useFakeTimers();

        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: false });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });
        const listeners = attachListenerDisposables(manager, diff.id);

        (fs.writeFileSync as jest.Mock).mockImplementation(() => {
            throw new Error('auto-save disk write failed');
        });

        manager.updateSettings({ autoSave: true, autoSaveDelay: 5 });
        (manager as any).scheduleAutoSave(diff.id);

        await jest.advanceTimersByTimeAsync(10);
        await Promise.resolve();

        expect(diff.status).toBe('rejected');
        expect((manager as any).autoSaveTimers.has(diff.id)).toBe(false);
        expect((manager as any).saveListeners.get(diff.id)).toBeUndefined();
        expect((manager as any).closeListeners.get(diff.id)).toBeUndefined();
        expect(listeners.saveDisposable.dispose).toHaveBeenCalled();
        expect(listeners.closeDisposable.dispose).toHaveBeenCalled();
        expect(diff.autoSaveError).toContain('Auto-save failed while accepting diff');
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
        expect((vscode.window as any).showErrorMessage).toHaveBeenCalled();
    });

    it('non-manual save lets auto-save flush to disk without triggering draft restore loop', async () => {
        const manager = getManager();
        const doc = createDocument({ initialContent: 'original', saveReturns: true });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted'
        });

        let willSaveHandler: ((event: any) => void) | undefined;
        let didSaveHandler: ((savedDoc: any) => Promise<void>) | undefined;

        (vscode.workspace as any).onWillSaveTextDocument = jest.fn((listener: (event: any) => void) => {
            willSaveHandler = listener;
            return { dispose: jest.fn() };
        });
        (vscode.workspace as any).onDidSaveTextDocument = jest.fn((listener: (savedDoc: any) => Promise<void>) => {
            didSaveHandler = listener;
            return { dispose: jest.fn() };
        });

        (vscode.window as any).showTextDocument = jest.fn(async () => ({
            edit: async (callback: (editBuilder: { replace: (range: unknown, text: string) => void }) => void) => {
                callback({
                    replace: (_range: unknown, text: string) => {
                        doc.setText(text);
                    }
                });
                return true;
            }
        }));

        let statusChanges = 0;
        manager.addStatusListener(() => {
            statusChanges += 1;
        });

        await (manager as any).showDiffView(diff);

        expect(doc.getText()).toBe('accepted');
        expect(diff.status).toBe('pending');
        expect(typeof willSaveHandler).toBe('function');
        expect(typeof didSaveHandler).toBe('function');

        // Simulate non-manual save (e.g., auto-save): willSave should just mark flushed, not block save
        let waitUntilCalled = false;
        willSaveHandler?.({
            document: doc,
            reason: (vscode as any).TextDocumentSaveReason.FocusOut,
            waitUntil: (_thenable: any) => {
                waitUntilCalled = true;
            }
        });

        // New behavior: willSave does NOT call event.waitUntil (no content blocking)
        expect(waitUntilCalled).toBe(false);
        expect((manager as any).nonManualSaveFlushed.has(diff.id)).toBe(true);

        // After save, diff should remain pending (not auto-accepted)
        await didSaveHandler?.(doc);

        expect(diff.status).toBe('pending');
        expect(statusChanges).toBe(0);
        expect((manager as any).nonManualSaveFlushed.has(diff.id)).toBe(false);
        expect((manager as any).saveListeners.has(diff.id)).toBe(true);
        expect((manager as any).willSaveListeners.has(diff.id)).toBe(true);
    });

    it('acceptDiff waits for checkpointReady before writing, then writes after resolve', async () => {
        (fs.writeFileSync as jest.Mock).mockClear();
        (fs.readFileSync as jest.Mock).mockClear();
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        let resolveCheckpoint!: () => void;
        const checkpointReady = new Promise<void>((resolve) => {
            resolveCheckpoint = resolve;
        });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted',
            checkpointReady
        });
        attachListenerDisposables(manager, diff.id);

        const acceptPromise = manager.acceptDiff(diff.id, false, false);
        await flushMicrotasks();

        // checkpoint 未 resolve：不读盘、不写盘、不保存，diff 保持 pending
        expect(diff.status).toBe('pending');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(manager.isDiffActionInProgress(diff.id)).toBe(true);

        resolveCheckpoint();
        const accepted = await acceptPromise;

        expect(accepted).toBe(true);
        expect(diff.status).toBe('accepted');
        expect(fs.readFileSync).toHaveBeenCalled();
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
    });

    it('rejecting checkpointReady blocks the write and converges the diff to rejected', async () => {
        (fs.writeFileSync as jest.Mock).mockClear();
        (fs.readFileSync as jest.Mock).mockClear();
        jest.useFakeTimers();

        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: false });
        const checkpointReady = Promise.reject(new Error('checkpoint failed'));
        // 预挂 catch 避免 Jest 把未处理拒绝计为测试失败；await 原 promise 仍会 reject
        checkpointReady.catch(() => undefined);
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted',
            checkpointReady
        });
        attachListenerDisposables(manager, diff.id);

        manager.updateSettings({ autoSave: true, autoSaveDelay: 5 });
        (manager as any).scheduleAutoSave(diff.id);

        await jest.advanceTimersByTimeAsync(10);
        await flushMicrotasks();

        expect(diff.status).toBe('rejected');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(diff.autoSaveError).toContain('Auto-save failed while accepting diff');
        expect((manager as any).autoSaveTimers.has(diff.id)).toBe(false);
        expect(manager.isDiffActionInProgress(diff.id)).toBe(false);
    });

    it('rejectDiff waits for checkpointReady before restoring the original content', async () => {
        (fs.writeFileSync as jest.Mock).mockClear();
        (fs.readFileSync as jest.Mock).mockClear();
        const manager = getManager();
        const doc = createDocument({ initialContent: 'accepted', saveReturns: true });
        let resolveCheckpoint!: () => void;
        const checkpointReady = new Promise<void>((resolve) => {
            resolveCheckpoint = resolve;
        });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted',
            checkpointReady
        });
        attachListenerDisposables(manager, diff.id);

        const rejectPromise = manager.rejectDiff(diff.id);
        await flushMicrotasks();

        // checkpoint 未 resolve：不恢复原文、不写盘，diff 保持 pending
        expect(doc.getText()).toBe('accepted');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(diff.status).toBe('pending');

        resolveCheckpoint();
        const rejected = await rejectPromise;

        expect(rejected).toBe(true);
        expect(doc.getText()).toBe('original');
        expect(diff.status).toBe('rejected');
    });

    it('directApplyAndSave waits for checkpointReady before writing to disk', async () => {
        (fs.writeFileSync as jest.Mock).mockClear();
        (fs.readFileSync as jest.Mock).mockClear();
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        let resolveCheckpoint!: () => void;
        const checkpointReady = new Promise<void>((resolve) => {
            resolveCheckpoint = resolve;
        });

        const pendingPromise = manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'accepted',
            undefined,
            undefined,
            'tool-1',
            { confirmedByToolConfirmation: true, checkpointReady }
        );
        await flushMicrotasks();

        // checkpoint 未 resolve：createPendingDiff 内部停在写盘前，不写盘
        expect(fs.writeFileSync).not.toHaveBeenCalled();

        resolveCheckpoint();
        const pendingDiff = await pendingPromise;

        expect(pendingDiff.status).toBe('accepted');
        expect(fs.writeFileSync).toHaveBeenCalledWith('C:/tmp/file.ts', 'accepted', 'utf8');
    });

    it('willSaveListener waits for checkpointReady via event.waitUntil on manual and non-manual saves', async () => {
        const manager = getManager();
        const doc = createDocument({ initialContent: 'original', saveReturns: true });
        let resolveCheckpoint!: () => void;
        const checkpointReady = new Promise<void>((resolve) => {
            resolveCheckpoint = resolve;
        });
        const diff = createPendingDiff(manager, {
            originalContent: 'original',
            newContent: 'accepted',
            checkpointReady
        });

        let willSaveHandler: ((event: any) => void) | undefined;
        (vscode.workspace as any).onWillSaveTextDocument = jest.fn((listener: (event: any) => void) => {
            willSaveHandler = listener;
            return { dispose: jest.fn() };
        });

        await (manager as any).showDiffView(diff);

        const waitUntilArgs: unknown[] = [];
        const fireWillSave = (reason: number): void => {
            willSaveHandler?.({
                document: doc,
                reason,
                waitUntil: (thenable: unknown) => {
                    waitUntilArgs.push(thenable);
                }
            });
        };

        // 手动保存路径：waitUntil 必须被调用
        fireWillSave((vscode as any).TextDocumentSaveReason.Manual);
        // 非手动保存路径：waitUntil 必须被调用，且仍记录 flushed 标记
        fireWillSave((vscode as any).TextDocumentSaveReason.FocusOut);

        expect(waitUntilArgs).toEqual([checkpointReady, checkpointReady]);
        expect((manager as any).nonManualSaveFlushed.has(diff.id)).toBe(true);

        resolveCheckpoint();
    });

    it('createPendingDiff stores structuredHunkPlan and checkpointReady from options', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        const plan = {
            normalizedOriginal: 'original',
            entries: [
                { index: 0, startIndex: 0, endIndex: 3, originalStartLine: 1, oldContent: 'abc', newContent: 'def' }
            ]
        };
        const checkpointReady = Promise.resolve(undefined);

        const pendingDiff = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'changed',
            undefined,
            undefined,
            undefined,
            { structuredHunkPlan: plan, checkpointReady }
        );

        expect(pendingDiff.structuredHunkPlan).toBe(plan);
        expect(pendingDiff.checkpointReady).toBe(checkpointReady);

        await manager.rejectDiff(pendingDiff.id);
    });
});

describe('DiffManager conversationId scoping (#48)', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        resetDiffManagerSingleton();

        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);

        (vscode as any).EventEmitter = class {
            public event = jest.fn();
            public fire = jest.fn();
            public dispose = jest.fn();
        };
        (vscode as any).WorkspaceEdit = MockWorkspaceEdit;
        (vscode as any).Range = jest.fn().mockImplementation(() => ({ start: 0, end: 0 }));
        (vscode as any).TabInputTextDiff = class {};
        (vscode as any).TextEdit = { replace: jest.fn(() => ({})) };
        (vscode.Uri as any).parse = (v: string) => ({ fsPath: v, scheme: 'file', path: v });
        (vscode.Uri as any).file = (v: string) => ({ fsPath: v, scheme: 'file', path: v });
        (vscode as any).TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };

        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).registerTextDocumentContentProvider = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).openTextDocument = jest.fn();
        (vscode.workspace as any).applyEdit = jest.fn(async () => true);
        (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onWillSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onDidCloseTextDocument = jest.fn(() => ({ dispose: jest.fn() }));

        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode as any).window = {
            showTextDocument: jest.fn(async () => ({})),
            setStatusBarMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            tabGroups: {
                all: [],
                close: jest.fn(async () => undefined)
            }
        };

        (fs.readFileSync as jest.Mock).mockReturnValue('original');
        (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    });

    afterEach(() => {
        resetDiffManagerSingleton();
    });

    it('cancelAllPending with conversationId only cancels matching diffs', async () => {
        const manager = getManager();
        const diffA = createPendingDiff(manager, { id: 'diff-A', conversationId: 'conv-A' });
        const diffB = createPendingDiff(manager, { id: 'diff-B', conversationId: 'conv-B' });

        // Cancel only conv-A's diffs
        const result = await manager.cancelAllPending('conv-A');

        expect(result.cancelled.length).toBe(1);
        expect(result.cancelled[0].id).toBe('diff-A');
        expect(diffA.status).toBe('rejected');
        // conv-B's diff should remain untouched
        expect(diffB.status).toBe('pending');
    });

    it('cancelAllPending without conversationId cancels all diffs', async () => {
        const manager = getManager();
        const diffA = createPendingDiff(manager, { id: 'diff-A', conversationId: 'conv-A' });
        const diffB = createPendingDiff(manager, { id: 'diff-B', conversationId: 'conv-B' });

        const result = await manager.cancelAllPending();

        expect(result.cancelled.length).toBe(2);
        expect(diffA.status).toBe('rejected');
        expect(diffB.status).toBe('rejected');
    });

    it('markUserInterrupt scoped by conversationId', () => {
        const manager = getManager();
        // No conversationId means global interrupt
        manager.markUserInterrupt();
        expect(manager.isUserInterrupted()).toBe(true);
        manager.resetUserInterrupt();
        expect(manager.isUserInterrupted()).toBe(false);

        // With conversationId
        manager.markUserInterrupt('conv-A');
        expect(manager.isUserInterrupted('conv-A')).toBe(true);
        expect(manager.isUserInterrupted('conv-B')).toBe(false);
        // Without conversationId still returns true (global interrupt is on)
        expect(manager.isUserInterrupted()).toBe(true);

        manager.resetUserInterrupt('conv-A');
        expect(manager.isUserInterrupted('conv-A')).toBe(false);
        // 实现有意同步清理：无其他会话中断时，全局标记随最后一个会话重置
        // （否则无 conversationId 的 diff 会被残留的 globalUserInterrupt 误伤）
        expect(manager.isUserInterrupted()).toBe(false);

        manager.resetUserInterrupt();
        expect(manager.isUserInterrupted()).toBe(false);
    });
});

describe('DiffManager fifo eviction (#10)', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        resetDiffManagerSingleton();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);

        (vscode as any).EventEmitter = class { public event = jest.fn(); public fire = jest.fn(); public dispose = jest.fn(); };
        (vscode as any).WorkspaceEdit = MockWorkspaceEdit;
        (vscode as any).Range = jest.fn().mockImplementation();
        (vscode as any).TextEdit = { replace: jest.fn(() => ({})) };
        (vscode.Uri as any).parse = (v: string) => ({ fsPath: v });
        (vscode.Uri as any).file = (v: string) => ({ fsPath: v });
        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).registerTextDocumentContentProvider = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).openTextDocument = jest.fn();
        (vscode.workspace as any).applyEdit = jest.fn(async () => true);
        (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onWillSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onDidCloseTextDocument = jest.fn(() => ({ dispose: jest.fn() }));

        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode as any).window = {
            showTextDocument: jest.fn(),
            setStatusBarMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            tabGroups: { all: [], close: jest.fn(async () => undefined) }
        };

        (fs.readFileSync as jest.Mock).mockReturnValue('original');
        (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    });

    afterEach(() => {
        resetDiffManagerSingleton();
    });

    it('evicts oldest finalized diffs when queue exceeds MAX_FINALIZED_DIFFS', async () => {
        const manager = getManager();
        const MAX = (DiffManager as any).MAX_FINALIZED_DIFFS;

        // Create more than MAX diffs and reject them
        for (let i = 0; i < MAX + 5; i++) {
            const diff = createPendingDiff(manager, { id: `diff-${i}` });
            await manager.rejectDiff(diff.id);
        }

        const finalizedOrder: string[] = (manager as any).finalizedDiffOrder;
        expect(finalizedOrder.length).toBeLessThanOrEqual(MAX);

        // Oldest should be evicted from pendingDiffs
        expect((manager as any).pendingDiffs.has('diff-0')).toBe(false);
        expect((manager as any).pendingDiffs.has('diff-1')).toBe(false);
        expect((manager as any).pendingDiffs.has('diff-2')).toBe(false);
        expect((manager as any).pendingDiffs.has('diff-3')).toBe(false);
        expect((manager as any).pendingDiffs.has('diff-4')).toBe(false);

        // Newest entries should still be available (for tool chain to read)
        const lastIdx = MAX + 4;
        expect((manager as any).pendingDiffs.has(`diff-${lastIdx}`)).toBe(true);
    });
});

describe('DiffManager newFile through CreatePendingDiffOptions (#14)', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        resetDiffManagerSingleton();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        (vscode as any).EventEmitter = class { public event = jest.fn(); };
        (vscode as any).WorkspaceEdit = MockWorkspaceEdit;
        (vscode as any).Range = jest.fn().mockImplementation();
        (vscode as any).TextEdit = { replace: jest.fn() };
        (vscode.Uri as any).parse = (v: string) => ({ fsPath: v });
        (vscode.Uri as any).file = (v: string) => ({ fsPath: v });
        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).registerTextDocumentContentProvider = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).openTextDocument = jest.fn();
        (vscode.workspace as any).applyEdit = jest.fn(async () => true);
        (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onWillSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.workspace as any).onDidCloseTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode as any).window = {
            showTextDocument: jest.fn(),
            setStatusBarMessage: jest.fn(),
            tabGroups: { all: [], close: jest.fn(async () => undefined) }
        };
        (fs.readFileSync as jest.Mock).mockReturnValue('original');
        (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    });

    afterEach(() => {
        resetDiffManagerSingleton();
    });

    it('sets newFile flag during createPendingDiff, before showDiffView', async () => {
        const manager = getManager();

        const pendingDiff = await manager.createPendingDiff(
            'src/newfile.ts',
            'C:/tmp/newfile.ts',
            '',
            'new content',
            undefined, undefined, undefined,
            { newFile: true }
        );

        expect(pendingDiff.newFile).toBe(true);

        // Cancel: should try to delete the new file
        await manager.rejectDiff(pendingDiff.id);
        expect(fs.unlinkSync).toHaveBeenCalledWith('C:/tmp/newfile.ts');
    });
});


describe('DiffManager PERF-CP deferred write lock', () => {
    const OTHER_HOLDER = { kind: 'main' as const, id: 'other', label: 'other writer' };

    beforeEach(() => {
        jest.restoreAllMocks();
        resetDiffManagerSingleton();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        (vscode as any).window = {
            showTextDocument: jest.fn(async () => ({})),
            setStatusBarMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            tabGroups: { all: [], close: jest.fn(async () => undefined) }
        };
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    });

    afterEach(() => {
        // 清理可能残留的锁（真实单例，跨用例不共享状态）
        fileWriteLockManager.release(['C:/tmp/file.ts'], OTHER_HOLDER);
        resetDiffManagerSingleton();
    });

    it('预览显示后获取写盘锁并持有到 diff 终结（终结后其他写入者可获取）', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });

        const pending = await manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'changed',
            undefined, undefined, undefined,
            { lockHolder: { kind: 'main', id: 'conv-x', label: 'main session' } }
        );

        // 审阅期间写盘锁已持有：其他写入者 tryAcquire 失败
        expect(pending.lockAcquired).toBe(true);
        const conflict = fileWriteLockManager.tryAcquire(['C:/tmp/file.ts'], OTHER_HOLDER);
        expect(conflict.acquired).toBe(false);

        // 终结（拒绝）后锁释放：其他写入者可获取
        await manager.rejectDiff(pending.id);
        const after = fileWriteLockManager.tryAcquire(['C:/tmp/file.ts'], OTHER_HOLDER);
        expect(after.acquired).toBe(true);
        fileWriteLockManager.release(['C:/tmp/file.ts'], OTHER_HOLDER);
    });

    it('写盘锁冲突：createPendingDiff 收敛 rejected 并抛出冲突错误', async () => {
        const manager = getManager();
        createDocument({ initialContent: 'original', saveReturns: true });
        // 其他写入者先占锁
        const occupied = fileWriteLockManager.tryAcquire(['C:/tmp/file.ts'], OTHER_HOLDER);
        expect(occupied.acquired).toBe(true);

        await expect(manager.createPendingDiff(
            'src/file.ts',
            'C:/tmp/file.ts',
            'original',
            'changed',
            undefined, undefined, undefined,
            { lockHolder: { kind: 'main', id: 'conv-x', label: 'main session' } }
        )).rejects.toThrow(/File write conflict/);

        // diff 已收敛为 rejected（不悬挂 pending）
        const diffs = Array.from((manager as any).pendingDiffs.values()) as PendingDiff[];
        expect(diffs.length).toBe(1);
        expect(diffs[0].status).toBe('rejected');
        expect(diffs[0].lockAcquired).not.toBe(true);

        // 释放占锁，避免影响后续用例
        fileWriteLockManager.release(['C:/tmp/file.ts'], OTHER_HOLDER);
    });
});