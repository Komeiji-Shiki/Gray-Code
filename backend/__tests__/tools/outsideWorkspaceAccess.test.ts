import * as path from 'path';
import * as vscode from 'vscode';
import {
    ensureOutsideWorkspaceAccessApproved,
    getOutsideWorkspaceAccessCheck,
    getOutsideWorkspaceRejectionReason,
    toolCallNeedsOutsideWorkspaceConfirmation
} from '../../tools/file/outsideWorkspaceAccess';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

describe('outside workspace file access policy', () => {
    let settingsManager: SettingsManager;
    let outsidePath: string;

    beforeEach(async () => {
        jest.clearAllMocks();

        const workspaceRoot = path.resolve('/workspace/project');
        outsidePath = path.resolve('/tmp/secret.txt');
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        }];

        settingsManager = new SettingsManager(new MemorySettingsStorage());
        await settingsManager.initialize();
        setGlobalSettingsManager(settingsManager);
    });

    it('denies outside-workspace reads by default without showing VS Code modal', () => {
        const args = { files: [{ path: outsidePath }] };
        const result = getOutsideWorkspaceAccessCheck('read_file', args, settingsManager);

        expect(result.denied).toBe(true);
        expect(result.error).toContain('disabled in settings');
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('allows outside-workspace reads directly when configured', async () => {
        await settingsManager.updateToolConfig('read_file', { outsideWorkspaceAccess: 'allow' });

        const args = { files: [{ path: outsidePath }] };
        const result = getOutsideWorkspaceAccessCheck('read_file', args, settingsManager);

        expect(result.denied).toBe(false);
        expect(result.requiresConfirmation).toBe(false);
        expect(ensureOutsideWorkspaceAccessApproved('read_file', args)).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('routes outside-workspace reads through the original tool confirmation when configured as ask', async () => {
        await settingsManager.updateToolConfig('read_file', { outsideWorkspaceAccess: 'ask' });

        const args = { files: [{ path: outsidePath }] };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('read_file', args, settingsManager)).toBe(true);
        expect(ensureOutsideWorkspaceAccessApproved('read_file', args)).toContain('needs user confirmation');
        expect(ensureOutsideWorkspaceAccessApproved('read_file', args, { approvedByToolConfirmation: true })).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('denies outside-workspace writes by default', () => {
        const args = { files: [{ path: outsidePath, content: 'x' }] };
        const error = getOutsideWorkspaceRejectionReason('write_file', args, settingsManager);

        expect(error).toContain('disabled in settings');
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('uses manual diff review as the outside-workspace confirmation for writes when configured as ask', async () => {
        await settingsManager.updateToolConfig('write_file', { outsideWorkspaceAccess: 'ask' });

        const args = { files: [{ path: outsidePath, content: 'x' }] };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('write_file', args, settingsManager)).toBe(false);
        expect(ensureOutsideWorkspaceAccessApproved('write_file', args)).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('routes outside-workspace writes through tool confirmation when auto applying diffs', async () => {
        await settingsManager.updateToolConfig('write_file', { outsideWorkspaceAccess: 'ask' });
        await settingsManager.updateApplyDiffConfig({ autoSave: true });

        const args = { files: [{ path: outsidePath, content: 'x' }] };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('write_file', args, settingsManager)).toBe(true);
        expect(ensureOutsideWorkspaceAccessApproved('write_file', args)).toContain('needs user confirmation');
        expect(ensureOutsideWorkspaceAccessApproved('write_file', args, { approvedByToolConfirmation: true })).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('uses manual diff review as the outside-workspace confirmation for apply_diff when configured as ask', async () => {
        await settingsManager.updateApplyDiffConfig({ outsideWorkspaceAccess: 'ask' });

        const args = { path: outsidePath, patch: '@@ -1,1 +1,1 @@\n-old\n+new' };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('apply_diff', args, settingsManager)).toBe(false);
        expect(ensureOutsideWorkspaceAccessApproved('apply_diff', args)).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('routes outside-workspace apply_diff through tool confirmation when auto applying diffs', async () => {
        await settingsManager.updateApplyDiffConfig({ outsideWorkspaceAccess: 'ask', autoSave: true });

        const args = { path: outsidePath, patch: '@@ -1,1 +1,1 @@\n-old\n+new' };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('apply_diff', args, settingsManager)).toBe(true);
        expect(ensureOutsideWorkspaceAccessApproved('apply_diff', args)).toContain('needs user confirmation');
        expect(ensureOutsideWorkspaceAccessApproved('apply_diff', args, { approvedByToolConfirmation: true })).toBeNull();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});
