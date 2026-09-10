import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

// 文件编辑与审查共用 Worker 和主题，先打开任意一种面板都能正常显示代码。
const editorGlobal = self as typeof self & { MonacoEnvironment?: { getWorker: (_id: string, label: string) => Worker } };
editorGlobal.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker()
  : ['css', 'scss', 'less'].includes(label) ? new CssWorker()
    : ['html', 'handlebars', 'razor'].includes(label) ? new HtmlWorker()
      : ['typescript', 'javascript'].includes(label) ? new TsWorker() : new EditorWorker() };
monaco.editor.defineTheme('graycode-workbench-dark', {
  base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#0d1117', 'editor.foreground': '#d1d9e0', 'editorGutter.background': '#0d1117',
    'editorLineNumber.foreground': '#667386', 'editorLineNumber.activeForeground': '#d1d9e0',
    'editor.lineHighlightBackground': '#ffffff04', 'editor.selectionBackground': '#388bfd32',
    'diffEditor.insertedTextBackground': '#3fb9502a', 'diffEditor.insertedLineBackground': '#2ea04318',
    'diffEditor.removedTextBackground': '#f851492d', 'diffEditor.removedLineBackground': '#da36331b',
    'diffEditorGutter.insertedLineBackground': '#3fb95048', 'diffEditorGutter.removedLineBackground': '#f8514948',
    'diffEditor.diagonalFill': '#202630',
  },
});
export function workbenchEditorTheme(theme?: string): string { return theme === 'light' ? 'vs' : 'graycode-workbench-dark'; }
