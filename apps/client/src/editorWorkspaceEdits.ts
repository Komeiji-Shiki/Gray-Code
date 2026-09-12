import * as monaco from 'monaco-editor';
import { EditorBatchHistory, type BatchEditTarget, type EditBatchHandle } from '../../../shared/editorBatchHistory';
import { report } from './state';

const batchHistory = new EditorBatchHistory();
const modelTargets = new WeakMap<monaco.editor.ITextModel, BatchEditTarget>();
function target(model: monaco.editor.ITextModel): BatchEditTarget {
  let value = modelTargets.get(model);
  if (!value) {
    value = { version: () => model.getAlternativeVersionId(), disposed: () => model.isDisposed(),
      undo: () => model.undo(), redo: () => model.redo() };
    modelTargets.set(model, value);
  }
  return value;
}

export function applyWorkspaceTextEdits(changes: monaco.languages.WorkspaceEdit): EditBatchHandle {
  const grouped = new Map<monaco.editor.ITextModel, monaco.editor.IIdentifiedSingleEditOperation[]>();
  for (const change of changes.edits) {
    if (!('textEdit' in change)) throw new Error('此操作包含文件创建或移动，请通过文件操作处理。');
    const model = monaco.editor.getModel(change.resource);
    if (!model || change.versionId !== undefined && model.getVersionId() !== change.versionId) throw new Error('编辑内容已变化，请重新执行操作。');
    const range = monaco.Range.lift(change.textEdit.range);
    if (!monaco.Range.equalsRange(range, model.validateRange(range))) throw new Error('编辑范围已失效，请重新执行操作。');
    grouped.set(model, [...grouped.get(model) ?? [], { range, text: change.textEdit.text, forceMoveMarkers: true }]);
  }
  for (const edits of grouped.values()) {
    const sorted = [...edits].sort((left, right) => monaco.Range.compareRangesUsingStarts(left.range, right.range));
    for (let index = 1; index < sorted.length; index++) {
      if (monaco.Range.areIntersecting(sorted[index - 1].range, sorted[index].range)) throw new Error('同一批修改包含相互重叠的范围。');
    }
  }
  const entries = [...grouped].map(([model, edits]) => {
    const item = { target: target(model), before: model.getAlternativeVersionId(), after: 0 };
    model.pushStackElement(); model.pushEditOperations([], edits, () => []); model.pushStackElement();
    item.after = model.getAlternativeVersionId(); return item;
  });
  return batchHistory.record(entries);
}

// Monaco 的独立宿主默认逐文件建立撤销记录；此公共服务覆盖让重命名与修复也按整批处理。
export const workspaceEditorServices: monaco.editor.IEditorOverrideServices = {
  IWorkspaceEditService: {
    hasPreviewHandler: () => false,
    async apply(input: monaco.languages.WorkspaceEdit | monaco.languages.WorkspaceEdit['edits']) {
      const changes = Array.isArray(input) ? { edits: input } : input;
      applyWorkspaceTextEdits(changes);
      return { isApplied: changes.edits.length > 0, ariaSummary: `已应用 ${changes.edits.length} 处修改。` };
    },
  },
};

export function bindEditorUndo(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const change = editor.onDidChangeModelContent(event => {
    const model = editor.getModel();
    if (model && !event.isUndoing && !event.isRedoing) batchHistory.invalidateRedo(target(model));
  });
  const run = (undo: boolean) => {
    const model = editor.getModel();
    if (model) return batchHistory.move(target(model), undo).catch(report);
  };
  const undo = editor.addAction({ id: 'undo', label: '撤销', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ], run: () => run(true) });
  const redo = editor.addAction({ id: 'redo', label: '重做', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ], run: () => run(false) });
  return { dispose() { change.dispose(); undo.dispose(); redo.dispose(); } };
}
