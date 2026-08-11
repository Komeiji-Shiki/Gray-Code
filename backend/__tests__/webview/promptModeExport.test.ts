import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { exportPromptModes } from '../../../webview/handlers/SettingsHandlers';

jest.mock('fs/promises', () => ({
    writeFile: jest.fn()
}));

describe('exportPromptModes', () => {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    const ctx = { sendResponse, sendError } as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('does not write a file when the save dialog is cancelled', async () => {
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(undefined);

        await exportPromptModes(
            { filename: 'mode.json', content: '{"mode":true}' },
            'request-1',
            ctx
        );

        expect(fs.writeFile).not.toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith('request-1', { success: false, cancelled: true });
        expect(sendError).not.toHaveBeenCalled();
    });

    test('reports success only after the selected file is written', async () => {
        const target = vscode.Uri.file('/tmp/mode.json');
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(target);
        (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

        await exportPromptModes(
            { filename: 'mode.json', content: '{"mode":true}' },
            'request-2',
            ctx
        );

        expect(fs.writeFile).toHaveBeenCalledWith(target.fsPath, '{"mode":true}', 'utf-8');
        expect(sendResponse).toHaveBeenCalledWith('request-2', { success: true, filePath: target.fsPath });
        expect(sendError).not.toHaveBeenCalled();
    });
});
