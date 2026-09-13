import { watch } from 'vue';
import * as monaco from 'monaco-editor';
import { changeBreakpoints, connectDebugging, debugState, loadDebugSettings, toggleBreakpoint } from './debugging';
import { report } from './state';

/** 使用 Monaco 的装饰范围跟随编辑与撤销移动断点，不重建文本模型。 */
export function bindEditorDebugging(editor: monaco.editor.IStandaloneCodeEditor, workspaceId: string, file: string) {
  connectDebugging();
  const model = editor.getModel()!;
  let decorations: string[] = [], ids: string[] = [], positionsDirty = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = editor.createDecorationsCollection();
  const render = () => {
    const previous = new Map(ids.map((id, index) => [id, model.getDecorationRange(decorations[index])?.startLineNumber]));
    const values = debugState.settings[workspaceId]?.breakpoints.filter(value => value.path === file) ?? [];
    const active = debugState.results[debugState.activeId]?.[file] ?? [];
    let enabledIndex = 0;
    const next = values.map(value => {
      const result = value.enabled ? active[enabledIndex++] : undefined;
      const line = Math.min(model.getLineCount(), positionsDirty && previous.get(value.id) || value.line);
      return { range: new monaco.Range(line, 1, line, 1), options: {
        glyphMarginClassName: !value.enabled ? 'debug-breakpoint-disabled' : result && !result.verified ? 'debug-breakpoint-pending' : value.logMessage ? 'debug-logpoint' : 'debug-breakpoint',
        glyphMarginHoverMessage: { value: [value.logMessage ? '日志断点' : '断点', value.condition, value.hitCondition, result?.message].filter(Boolean).join(' · ') },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      } };
    });
    decorations = model.deltaDecorations(decorations, next); ids = values.map(value => value.id);
    const location = debugState.location;
    execution.set(location?.workspaceId === workspaceId && location.path === file ? [{ range: new monaco.Range(location.line, 1, location.line, 1),
      options: { isWholeLine: true, className: 'debug-execution-line', linesDecorationsClassName: 'debug-execution-arrow' } }] : []);
  };
  const stopWatching = watch(() => [debugState.settings[workspaceId]?.breakpoints, debugState.results[debugState.activeId]?.[file], debugState.location], render, { deep: true });
  void loadDebugSettings(workspaceId).catch(report);
  const toggle = () => { const position = editor.getPosition(); if (position) void toggleBreakpoint(workspaceId, file, position.lineNumber).catch(report); };
  const mouse = editor.onMouseDown(event => {
    if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position)
      void toggleBreakpoint(workspaceId, file, event.target.position.lineNumber).catch(report);
  });
  const action = editor.addAction({ id: 'graycode.toggleBreakpoint', label: '切换当前行断点', keybindings: [monaco.KeyCode.F9], run: toggle });
  const persist = async () => {
    if (disposed || !positionsDirty) return;
    let version = model.getVersionId();
    try {
      await changeBreakpoints(workspaceId, values => {
        if (disposed) return values;
        version = model.getVersionId();
        const positions = new Map(ids.map((id, index) => [id, model.getDecorationRange(decorations[index])?.startLineNumber]));
        return values.map(value => value.path === file && positions.get(value.id) ? { ...value, line: positions.get(value.id)! } : value);
      });
      if (!disposed && version === model.getVersionId()) { positionsDirty = false; render(); }
    } catch (error) { report(error); }
  };
  const changed = model.onDidChangeContent(() => {
    if (!ids.some((id, index) => model.getDecorationRange(decorations[index])?.startLineNumber !== debugState.settings[workspaceId]?.breakpoints.find(value => value.id === id)?.line)) return;
    positionsDirty = true; clearTimeout(timer); timer = setTimeout(() => void persist(), 200);
  });
  render();
  return { dispose() { disposed = true; clearTimeout(timer); stopWatching(); mouse.dispose(); changed.dispose(); action?.dispose(); execution.clear(); if (!model.isDisposed()) model.deltaDecorations(decorations, []); } };
}
