import * as vscode from 'vscode';
import { getAllWorkspaces, resolveUriWithInfo } from '../shared/workspacePaths';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { createReadFileTool as createRuntime, type ReadFileHost } from './readFileRuntime';
const host: ReadFileHost = {
getAllWorkspaces, resolveUriWithInfo,
stat: async uri => vscode.workspace.fs.stat(uri as vscode.Uri),
readFile: async uri => vscode.workspace.fs.readFile(uri as vscode.Uri),
ensureOutsideWorkspaceAccessApproved: (args, context) => ensureOutsideWorkspaceAccessApproved('read_file', args, context),
};
/** VS Code 只负责提供真实宿主能力，读取行为由共用实现负责。 */
export function createReadFileTool(multimodalEnabled?: boolean,
channelType?: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
toolMode?: 'function_call' | 'xml' | 'json') { return createRuntime(host, multimodalEnabled, channelType, toolMode); }
export function registerReadFile() { return createReadFileTool(); }
