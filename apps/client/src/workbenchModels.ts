import { effectScope, shallowRef, watch, type ShallowRef } from 'vue';
import type { DocumentState, LanguageDocumentStatus } from '@graycode/contracts';
import * as monaco from './monaco';
import { bindLanguageDocument, editorUri } from './languages';
import { bindModelDebugging } from './editorDebugging';
import { bindModelUndo } from './editorWorkspaceEdits';
import { ensureEditorLanguage } from './editorLanguages';
import { report } from './state';
import { documentLanguageId, editorLanguageId } from '../../../shared/documentLanguages';
import { documentChangeRegion, type DocumentChangeRegion } from '../../../shared/documentPatch';

interface ModelOperations {
  change(document: DocumentState, text: string, edit?: { previous: string; region: DocumentChangeRegion }): void;
  flush(document: DocumentState): Promise<unknown>;
  open(path: string, workspaceId: string, range?: monaco.IRange, focus?: boolean): Promise<void>;
}

export interface WorkbenchDocumentModel {
  model: monaco.editor.ITextModel;
  language: ReturnType<typeof bindLanguageDocument>;
  languageState: ShallowRef<LanguageDocumentStatus>;
  viewState: monaco.editor.ICodeEditorViewState | null;
  selection?: monaco.IRange;
}

interface OwnedModel extends WorkbenchDocumentModel {
  workspaceId: string;
  path: string;
  dispose(): void;
}

/** 文档持有模型、撤销栈与服务绑定；可见编辑器只借用模型，不负责释放。 */
export class WorkbenchDocumentModels {
  private readonly entries = new Map<DocumentState, OwnedModel>();
  constructor(private readonly operations: ModelOperations) {}

  prepare(document: DocumentState): WorkbenchDocumentModel {
    const previous = this.entries.get(document);
    if (previous?.workspaceId === document.workspaceId && previous.path === document.path) return previous;
    previous?.dispose();
    // prepare 也可能由编辑器挂载回调调用，模型监听必须脱离该组件的 effectScope。
    const scope = effectScope(true);
    const entry = scope.run((): OwnedModel => {
      const workspaceId = document.workspaceId, path = document.path;
      const model = monaco.editor.getModel(editorUri(workspaceId, path))
        ?? monaco.editor.createModel(document.text, editorLanguageId(documentLanguageId(path)), editorUri(workspaceId, path));
      void ensureEditorLanguage(editorLanguageId(documentLanguageId(path))).catch(report);
      const languageState = shallowRef<LanguageDocumentStatus>({ languageId: documentLanguageId(path) });
      const language = bindLanguageDocument({ model, workspaceId, path, version: () => document.version,
        flush: () => this.operations.flush(document),
        open: (file, range, focus) => this.operations.open(file, workspaceId, range, focus),
        status: value => { languageState.value = value; },
      });
      const debugging = bindModelDebugging(model, workspaceId, path);
      const undo = bindModelUndo(model);
      let applying = false, synced = model.getValue(undefined, true);
      const changed = model.onDidChangeContent(event => {
        language.clearMarkers();
        if (applying) return;
        const before = synced, text = model.getValue(undefined, true);
        synced = text;
        const region = event.isFlush || event.isEolChange ? undefined
          : documentChangeRegion(event.changes, text.length - model.getValueLength());
        this.operations.change(document, text, region ? { previous: before, region } : undefined);
      });
      // 使用 Vue 的合并更新，重连期间暂时读取的宿主文本不会覆盖最终保留的本地草稿。
      watch(() => document.text, text => {
        if (text === synced) return;
        applying = true;
        try { model.setValue(text); synced = model.getValue(undefined, true); }
        finally { applying = false; }
      });
      watch(() => document.version, () => { void language.updateMarkers(); });
      return { model, language, languageState, workspaceId, path,
        viewState: previous?.viewState ?? null,
        dispose() {
          scope.stop();
          changed.dispose();
          undo.dispose();
          debugging.dispose();
          language.dispose();
          model.dispose();
        },
      };
    })!;
    this.entries.set(document, entry);
    return entry;
  }

  reconcile(documents: readonly DocumentState[]): void {
    for (const [document, entry] of this.entries) {
      if (!documents.includes(document)) { entry.dispose(); this.entries.delete(document); }
      else if (entry.workspaceId !== document.workspaceId || entry.path !== document.path) this.prepare(document);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}
