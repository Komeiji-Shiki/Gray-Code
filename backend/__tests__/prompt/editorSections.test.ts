import { formatDiagnosticsSection, type DiagnosticSectionFile } from '../../modules/prompt/editorSections';
import { DEFAULT_DIAGNOSTICS_CONFIG } from '../../modules/settings/types/contextTypes';
const config = { ...DEFAULT_DIAGNOSTICS_CONFIG, enabled: true };
const files: DiagnosticSectionFile[] = [
  { path: 'a.ts', inWorkspace: true, open: true, diagnostics: [
    { line: 1, severity: 'error', message: 'first problem' }, { line: 2, severity: 'warning', message: 'second problem' }] },
  { path: 'excluded.ts', inWorkspace: false, open: false, diagnostics: [{ line: 1, severity: 'error', message: 'outside workspace' }] },
  { path: 'b.ts', inWorkspace: true, open: true, diagnostics: [{ line: 3, severity: 'error', message: 'another file' }] },
];
test('数量限制明确说明省略了诊断或文件，保留原始排序与范围', () => {
  const text = formatDiagnosticsSection({ ...config, maxDiagnosticsPerFile: 1, maxFiles: 1 }, files);
  expect(text).toContain('Line 1: [Error] first problem');
  expect(text).toContain('1 more diagnostics omitted');
  expect(text).toContain('Additional files with diagnostics omitted by maxFiles=1');
  expect(text).not.toContain('outside workspace'); expect(text).not.toContain('second problem');
});
test('零范围不会冒充没有问题，无诊断时仍保留原来的明确说明', () => {
  for (const limits of [{ maxFiles: 0 }, { maxDiagnosticsPerFile: 0 }]) {
    const text = formatDiagnosticsSection({ ...config, ...limits }, files);
    expect(text).toContain('configured diagnostic limit is 0'); expect(text).not.toContain('No diagnostics were found');
  }
  expect(formatDiagnosticsSection(config, [])).toContain('No diagnostics were found');
  expect(formatDiagnosticsSection({ ...config, enabled: false }, files)).toBe('');
});
test('无限制时保留全部匹配诊断，不会把过滤掉的文件当成截断', () => {
  const unlimited = formatDiagnosticsSection({ ...config, maxFiles: -1, maxDiagnosticsPerFile: -1 }, files);
  expect(unlimited).toContain('second problem'); expect(unlimited).toContain('another file'); expect(unlimited).not.toContain('omitted');
  const onlyOne = formatDiagnosticsSection({ ...config, maxFiles: 1 }, files.slice(0, 2));
  expect(onlyOne).not.toContain('Additional files');
});
