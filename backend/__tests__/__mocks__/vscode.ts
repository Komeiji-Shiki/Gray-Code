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
        rename: jest.fn(),
        readDirectory: jest.fn(),
    },
    findFiles: jest.fn(),
    openTextDocument: jest.fn(),
    asRelativePath: jest.fn(),
    getWorkspaceFolder: jest.fn(),
    getConfiguration: jest.fn(),
    applyEdit: jest.fn(),
    onWillSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
};

function createFileUri(inputPath: string) {
    const fsPath = pathModule.resolve(inputPath);
    return { fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/') };
}

export const Uri = {
    file: createFileUri,
    parse: (value: string) => {
        const decoded = decodeURIComponent(value);
        if (/^file:\/\//i.test(decoded)) {
            // 只去掉 scheme 的 `file://`（两个斜杠），`file:///abs/path` 中属于路径本身的前导
            // 斜杠必须保留——原正则 `\/?` 会把第三个斜杠一起吃掉，Linux 上绝对路径被
            // 解析成相对路径（Windows 的 file://C:/ 形式只有两个斜杠，恰好不触发）。
            let filePath = decoded.replace(/^file:\/\//i, '');
            if (process.platform !== 'win32' && /^[a-zA-Z]:\//.test(filePath)) {
                filePath = `/${filePath}`;
            }
            return createFileUri(filePath);
        }
        return { fsPath: decoded, scheme: decoded.split(':')[0], path: decoded };
    },
    joinPath: jest.fn((base: any, ...paths: string[]) => createFileUri(pathModule.join(base.fsPath, ...paths))),
};

export const FileType = {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
};

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
};

export const ViewColumn = {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
};

export const Position = jest.fn((line: number = 0, character: number = 0) => ({ line, character }));
export const Range = jest.fn((...args: any[]) => {
    if (args.length === 2) return { start: args[0], end: args[1] };
    return {
        start: { line: args[0] ?? 0, character: args[1] ?? 0 },
        end: { line: args[2] ?? args[0] ?? 0, character: args[3] ?? args[1] ?? 0 },
    };
});

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
    showInformationMessage: jest.fn(),
    showTextDocument: jest.fn(),
    setStatusBarMessage: jest.fn(),
    tabGroups: { all: [], close: jest.fn() },
    // ActivityTracker 依赖的窗口状态/活动事件（返回可 dispose 的订阅对象）
    state: { focused: true },
    onDidChangeWindowState: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorVisibleRanges: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    onDidOpenTerminal: jest.fn(() => ({ dispose: jest.fn() })),
};
export const SymbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
};
