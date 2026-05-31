import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { registerWriteFile } from '../../tools/file/write_file';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn()
}));

const mockDiffManager = {
    createPendingDiff: jest.fn(),
    getDiff: jest.fn(),
    isUserInterrupted: jest.fn(),
    rejectDiff: jest.fn(),
    waitForDiffResolution: jest.fn()
};

jest.mock('../../tools/file/diffManager', () => ({
    getDiffManager: () => mockDiffManager
}));

jest.mock('../../modules/conversation', () => ({
    getDiffStorageManager: () => null
}));

describe('write_file outside-workspace flow', () => {
    let settingsManager: SettingsManager;

    beforeEach(async () => {
        jest.clearAllMocks();

        const workspaceRoot = path.resolve('/workspace/project');
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        }];

        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('missing'));
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        mockDiffManager.createPendingDiff.mockResolvedValue({ id: 'diff-1', status: 'pending' });
        mockDiffManager.getDiff.mockReturnValue({ id: 'diff-1', status: 'accepted' });
        mockDiffManager.isUserInterrupted.mockReturnValue(false);
        mockDiffManager.rejectDiff.mockResolvedValue(true);
        mockDiffManager.waitForDiffResolution.mockResolvedValue('none');

        settingsManager = new SettingsManager(new MemorySettingsStorage());
        await settingsManager.initialize();
        await settingsManager.updateToolConfig('write_file', { outsideWorkspaceAccess: 'ask' });
        setGlobalSettingsManager(settingsManager);
    });

    it('uses the real outside-workspace target file for new-file diff review', async () => {
        const outsidePath = path.resolve('/tmp/outside-new.txt');
        const expectedAbsolutePath = vscode.Uri.file(outsidePath).fsPath;
        const tool = registerWriteFile();

        const result = await tool.handler(
            { path: outsidePath, content: 'hello outside' },
            { toolId: 'tool-1' }
        );

        expect(result.success).toBe(true);
        expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(expectedAbsolutePath), { recursive: true });
        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedAbsolutePath, '', 'utf8');

        expect(mockDiffManager.createPendingDiff).toHaveBeenCalledTimes(1);
        const [, diffAbsolutePath, originalContent, newContent, _blocks, _diffs, toolId, options] =
            mockDiffManager.createPendingDiff.mock.calls[0];

        expect(diffAbsolutePath).toBe(expectedAbsolutePath);
        expect(diffAbsolutePath).not.toContain('limcode-outside-workspace-write');
        expect(originalContent).toBe('');
        expect(newContent).toBe('hello outside');
        expect(toolId).toBe('tool-1');
        expect(options).toEqual({ confirmedByToolConfirmation: false });
    });

    it('marks confirmed write calls so auto-save does not wait for a second confirmation', async () => {
        const outsidePath = path.resolve('/tmp/outside-confirmed.txt');
        const tool = registerWriteFile();

        await tool.handler(
            { path: outsidePath, content: 'confirmed content' },
            { toolId: 'tool-2', approvedByToolConfirmation: true }
        );

        expect(mockDiffManager.createPendingDiff).toHaveBeenCalledTimes(1);
        const options = mockDiffManager.createPendingDiff.mock.calls[0][7];
        expect(options).toEqual({ confirmedByToolConfirmation: true });
    });
});
