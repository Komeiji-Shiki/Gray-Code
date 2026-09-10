import * as vscode from 'vscode';
import * as shells from './shellConfig';
import { getMaxOutputLines } from './outputDecoder';
import { createTerminalPrompts } from './promptDescriptionsRuntime';
const runtime = createTerminalPrompts({ shells, getMaxOutputLines, roots: () => (vscode.workspace.workspaceFolders ?? []).map(folder => ({ name: folder.name, path: folder.uri.fsPath })) });
export const { getAllWorkspaceRoots, getOSName, getExecuteCommandShellGuidanceDescription, getCwdParameterDescription } = runtime;
export type { WorkspaceRootPromptInfo } from './promptDescriptionsRuntime';
