import * as vscode from 'vscode';
import { getAllWorkspaces, resolveUriWithInfo } from '../shared/workspacePaths';
import { countTextFileLines } from '../shared/fileStats';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { createListFilesTool as createRuntime, type ListFilesHost } from './listFilesRuntime';
const host: ListFilesHost = { getAllWorkspaces, resolveUriWithInfo,
readDirectory: async uri => vscode.workspace.fs.readDirectory(uri as vscode.Uri),
joinPath: (uri,name) => vscode.Uri.joinPath(uri as vscode.Uri,name),
countTextFileLines: (uri,file) => countTextFileLines(uri as vscode.Uri,file),
ignorePatterns: () => getGlobalSettingsManager()?.getListFilesConfig().ignorePatterns,
checkAccess: (args,context) => ensureOutsideWorkspaceAccessApproved('list_files',args,context),
};
export function createListFilesTool() { return createRuntime(host); }
export function registerListFiles() { return createListFilesTool(); }
