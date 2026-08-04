// Minimal vscode mock for unit tests
import * as pathModule from 'path';

export const workspace = {
    workspaceFolders: [],
    textDocuments: [],
    fs: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        stat: jest.fn(),
        createDirectory: jest.fn(),
        delete: jest.fn(),
    },
    findFiles: jest.fn(),
    openTextDocument: jest.fn(),
    asRelativePath: jest.fn(),
    getWorkspaceFolder: jest.fn(),
    applyEdit: jest.fn(),
    onWillSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
};

function createFileUri(inputPath: string) {
    const fsPath = pathModule.resolve(inputPath);
    return { fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/') };
}

export const Uri = {
    file: createFileUri,
    parse: (value: string) => {
        if (value.startsWith('file://')) {
            return createFileUri(decodeURIComponent(value.replace(/^file:\/\//, '')));
        }
        return { fsPath: value, scheme: value.split(':')[0], path: value };
    },
    joinPath: jest.fn((base: any, ...paths: string[]) => createFileUri(pathModule.join(base.fsPath, ...paths))),
};

export const FileType = {
    File: 1,
    Directory: 2,
};

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
};

export const Position = jest.fn();
export const Range = jest.fn();

/** 文本标签页输入（PromptManager.openTabs 测试需要 instanceof 判断） */
export class TabInputText {
    constructor(public uri: any) {}
}
export const commands = { executeCommand: jest.fn() };
export const window = {
    showSaveDialog: jest.fn(),
    showOpenDialog: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showTextDocument: jest.fn(),
    setStatusBarMessage: jest.fn(),
    tabGroups: { all: [], close: jest.fn() },
};
export const SymbolKind = {};
