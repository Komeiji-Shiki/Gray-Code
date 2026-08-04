import * as path from 'path';
import * as vscode from 'vscode';
import {
    ensureOutsideWorkspaceAccessApproved,
    getOutsideWorkspaceAccessCheck,
    toolCallNeedsOutsideWorkspaceConfirmation
} from '../../tools/file/outsideWorkspaceAccess';

let mockSettingsManager: any = null;

jest.mock('../../core/settingsContext', () => ({
    getGlobalSettingsManager: () => mockSettingsManager
}));

jest.mock('../../modules/settings', () => ({
    DEFAULT_APPLY_DIFF_CONFIG: { outsideWorkspaceAccess: 'deny', autoSave: true },
    DEFAULT_READ_FILE_CONFIG: { outsideWorkspaceAccess: 'deny' },
    DEFAULT_WRITE_FILE_CONFIG: { outsideWorkspaceAccess: 'deny' }
}));

function fakeSettingsManager(access: 'deny' | 'ask' | 'allow') {
    return {
        getReadFileConfig: () => ({ outsideWorkspaceAccess: access }),
        getWriteFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }),
        getApplyDiffConfig: () => ({ outsideWorkspaceAccess: 'deny', autoSave: true })
    } as any;
}

describe('list_files outside workspace policy', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const workspaceRoot = path.resolve('/workspace/project');
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        }];
    });

    it('denies outside-workspace directory listing by default', () => {
        mockSettingsManager = fakeSettingsManager('deny');
        const args = { paths: [path.resolve('/tmp/secret-dir')] };
        const result = getOutsideWorkspaceAccessCheck('list_files', args, mockSettingsManager);

        expect(result.denied).toBe(true);
        expect(result.error).toContain('disabled in settings');
        expect(result.error).toContain('Reading');
        expect(ensureOutsideWorkspaceAccessApproved('list_files', args)).toContain('disabled in settings');
    });

    it('treats workspace-internal directories as allowed', () => {
        mockSettingsManager = fakeSettingsManager('deny');
        const args = { paths: ['src'] };
        const result = getOutsideWorkspaceAccessCheck('list_files', args, mockSettingsManager);

        expect(result.denied).toBe(false);
        expect(result.requiresConfirmation).toBe(false);
        expect(ensureOutsideWorkspaceAccessApproved('list_files', args)).toBeNull();
    });

    it('routes outside-workspace listing through tool confirmation when configured as ask', () => {
        mockSettingsManager = fakeSettingsManager('ask');
        const args = { paths: [path.resolve('/tmp/secret-dir')] };

        expect(toolCallNeedsOutsideWorkspaceConfirmation('list_files', args, mockSettingsManager)).toBe(true);
        expect(ensureOutsideWorkspaceAccessApproved('list_files', args)).toContain('needs user confirmation');
        expect(ensureOutsideWorkspaceAccessApproved('list_files', args, { approvedByToolConfirmation: true })).toBeNull();
    });

    it('respects allow policy for outside-workspace listing', () => {
        mockSettingsManager = fakeSettingsManager('allow');
        const args = { paths: [path.resolve('/tmp/secret-dir')] };
        const result = getOutsideWorkspaceAccessCheck('list_files', args, mockSettingsManager);

        expect(result.denied).toBe(false);
        expect(result.requiresConfirmation).toBe(false);
        expect(ensureOutsideWorkspaceAccessApproved('list_files', args)).toBeNull();
    });
});
