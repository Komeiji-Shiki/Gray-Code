import type { DiagnosticsConfig, DiagnosticSeverity } from '../settings/types/contextTypes';
import { shouldIgnorePath } from './ignorePatterns';

export interface DiagnosticSectionFile {
    path: string;
    inWorkspace: boolean;
    open: boolean;
    diagnostics: { severity: DiagnosticSeverity; line: number; message: string; source?: string }[];
}

/** 宿主提供文件与诊断快照，格式、过滤和数量规则沿用原提示词实现。 */
export function formatOpenTabsSection(files: readonly string[], maxTabs: number, ignorePatterns: string[]): string {
    const uniqueTabs = [...new Set(files.filter(file => !shouldIgnorePath(file, ignorePatterns)))];
    const limitedTabs = uniqueTabs.slice(0, maxTabs === -1 ? undefined : maxTabs);
    if (!limitedTabs.length) return '';
    let result = `Currently open files in editor:\n`;
    for (const tab of limitedTabs) result += `  - ${tab}\n`;
    if (uniqueTabs.length > limitedTabs.length) result += `  ... and ${uniqueTabs.length - limitedTabs.length} more files`;
    return result;
}

export function formatActiveEditorSection(file: string | undefined, ignorePatterns: string[]): string {
    return file && !shouldIgnorePath(file, ignorePatterns) ? `Currently active file: ${file}` : '';
}

export function formatDiagnosticsSection(config: DiagnosticsConfig, files: Iterable<DiagnosticSectionFile>, scope = 'the workspace'): string {
    if (!config.enabled) return '';
    if (config.maxFiles === 0 || config.maxDiagnosticsPerFile === 0)
        return 'Diagnostic context is omitted because a configured diagnostic limit is 0; this does not mean the files have no problems.';
    const labels: Record<DiagnosticSeverity, string> = { error: 'Error', warning: 'Warning', information: 'Info', hint: 'Hint' };
    const results: string[] = [];
    let omittedFiles = false;
    for (const file of files) {
        if (config.workspaceOnly && !file.inWorkspace || config.openFilesOnly && !file.open) continue;
        const matching = file.diagnostics.filter(item => config.includeSeverities.includes(item.severity));
        if (!matching.length) continue;
        if (config.maxFiles !== -1 && results.length >= config.maxFiles) { omittedFiles = true; break; }
        const diagnostics = matching.slice(0, config.maxDiagnosticsPerFile === -1 ? undefined : config.maxDiagnosticsPerFile);
        const lines = diagnostics.map(item => `  Line ${item.line}: [${labels[item.severity]}] ${item.message}${item.source ? ` (${item.source})` : ''}`);
        if (matching.length > diagnostics.length) lines.push(`  ... ${matching.length - diagnostics.length} more diagnostics omitted by the per-file limit.`);
        results.push(`${file.path}:\n${lines.join('\n')}`);
    }
    if (!results.length) {
        const selected = (config.includeSeverities || []).map(value => labels[value] || value).join(', ');
        const description = config.openFilesOnly ? 'open files only' : config.workspaceOnly ? 'workspace files only' : 'all files';
        return `No diagnostics were found in ${scope} (scope: ${description}, severities: ${selected || 'none'}).`;
    }
    if (omittedFiles) results.push(`... Additional files with diagnostics omitted by maxFiles=${config.maxFiles}.`);
    return `The following diagnostics were found in ${scope}:\n\n${results.join('\n\n')}`;
}
