import { fileURLToPath } from 'node:url';
import type { PlatformMessage, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { workspaceFilePath, workspaceRootFor } from '../workspace/paths';
import type { DiagnosticsConfig } from '../../../../backend/modules/settings/types/contextTypes';
import { formatDiagnosticsSection, type DiagnosticSectionFile } from '../../../../backend/modules/prompt/editorSections';

export interface PromptEditorSnapshot {
  workspaceId: string;
  openFiles: string[];
  activeFile?: string;
  diagnostics?: string;
}

/** 回合重试和自动继续复用原输入快照，不读取另一个客户端后来打开的文件。 */
export function previousEditorSnapshot(message: PlatformMessage | undefined, workspaceId: string): PromptEditorSnapshot | undefined {
  const value = message?.turnEditorContext as PromptEditorSnapshot | undefined;
  if (value?.workspaceId !== workspaceId || !Array.isArray(value.openFiles) || !value.openFiles.every(file => typeof file === 'string')) return;
  return { workspaceId, openFiles: [...value.openFiles], activeFile: typeof value.activeFile === 'string' ? value.activeFile : undefined,
    diagnostics: typeof value.diagnostics === 'string' ? value.diagnostics : undefined };
}

export function captureEditorSnapshot(app: PlatformApplication, actorId: string, clientId: string, workspace: WorkspaceDefinition, config: DiagnosticsConfig): PromptEditorSnapshot {
  const current = app.files.editorContext(clientId, workspace);
  const snapshot: PromptEditorSnapshot = { workspaceId: workspace.id, ...current };
  if (!config.enabled) return snapshot;
  const files = new Map<string, DiagnosticSectionFile>();
  let hasUnversionedReports = false;
  const severities = ['error', 'warning', 'information', 'hint'] as const;
  for (const report of app.languages.diagnostics({ actorId, clientId }, workspace.id)) {
    let absolute: string;
    try { absolute = fileURLToPath(report.uri); } catch { continue; }
    if (!workspaceRootFor(workspace, absolute)) continue;
    const file = workspaceFilePath(workspace, absolute);
    const version = app.files.documentVersion(clientId, workspace.id, file);
    if (version === undefined || version !== (report.version ?? report.receivedAtDocumentVersion)) continue;
    if (report.version === undefined) hasUnversionedReports = true;
    const entry: DiagnosticSectionFile = files.get(file) ?? { path: file, inWorkspace: true, open: current.openFiles.includes(file), diagnostics: [] };
    // LSP 严重程度从 1 开始；未指定时沿用界面中的提示类显示。
    entry.diagnostics.push(...report.diagnostics.map(item => ({ severity: severities[(item.severity ?? 3) - 1],
      line: item.range.start.line + 1, message: item.message, source: item.source })));
    files.set(file, entry);
  }
  snapshot.diagnostics = files.size
    ? formatDiagnosticsSection(config, files.values(), "the files reported by this client's language services")
    : "No up-to-date diagnostic report is available from this client's language services yet.";
  if (hasUnversionedReports) snapshot.diagnostics = 'Some language services omitted document versions; their latest received reports are included.\n\n' + snapshot.diagnostics;
  return snapshot;
}
