import * as monaco from './monaco';
import { workbenchThemeData } from './editorTheme';
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
export const WORKBENCH_THEME = 'graycode-workbench';
/**
 * 按当前色板（重新）定义并应用编辑器主题。必须在第一个编辑器注入宿主服务之后调用，
 * 避免主题 API 提前固定默认编辑服务；同名主题重定义后由 setTheme 即时生效。
 */
export function applyWorkbenchTheme(palette: Record<string, string>, light: boolean): void {
  monaco.editor.defineTheme(WORKBENCH_THEME, workbenchThemeData(palette, light));
  monaco.editor.setTheme(WORKBENCH_THEME);
}
