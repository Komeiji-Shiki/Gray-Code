import * as fs from 'fs';
import * as vscode from 'vscode';

jest.mock('fs', () => ({
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn(),
    unlinkSync: jest.fn()
}));

jest.mock('../../tools/file/DiffCodeLensProvider', () => ({
    getDiffCodeLensProvider: () => ({
        removeSession: jest.fn(),
        getSession: jest.fn(),
        getSessionByFilePath: jest.fn()
    })
}));

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
        conversationId: overrides?.conversationId
    };

    ((manager as any).pendingDiffs as Map<string, PendingDiff>).set(diff.id, diff);
    return diff;
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
        // Global flag still true since other conversations might be interrupted
        expect(manager.isUserInterrupted()).toBe(true);

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
