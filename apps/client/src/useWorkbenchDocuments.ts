import { reactive } from 'vue';
import type { DocumentState } from '@graycode/contracts';
import { documentTextPatch, trackDocumentChange, type DocumentChangeRegion, type TrackedDocumentChange } from '../../../shared/documentPatch';
import { PendingDocumentChanges } from './pendingDocumentChanges';
import { call } from './api';
import { report } from './state';
import { shellText as t } from './i18n';

export const workbenchDocumentKey = (document: Pick<DocumentState, 'workspaceId' | 'path'>) => `${document.workspaceId}:${document.path}`;

/** 文档同步、保存与断线恢复共用同一队列，不随可见编辑器切换而重建。 */
export function useWorkbenchDocuments(isDisposed: () => boolean) {
  const key = workbenchDocumentKey;
  const documents = reactive<DocumentState[]>([]);
  const synchronizedText = new WeakMap<DocumentState, { text: string; version: number }>();
  const changeTracks = new WeakMap<DocumentState, TrackedDocumentChange>();
  const queues = new Map<string, Promise<unknown>>();
  const recoveringDocuments = new Set<DocumentState>();
  const documentConflicts = new WeakSet<DocumentState>();
  const closingDocuments = new Set<DocumentState>();
  const connection = { connected: true };
  const recoveryConflict = (doc: DocumentState) => new Error(`${doc.path}: ${t('documentRecoveryConflict')}`);
  function flushDocument(doc: DocumentState) { return queues.get(key(doc)) ?? Promise.resolve(); }
  async function flushDocuments() { await Promise.all(documents.map(flushDocument)); }
  function queue(doc: DocumentState, operation: () => Promise<unknown>, isChange = false) {
    if (!isChange) pendingChanges.barrier(doc);
    const id = key(doc);
    const promise = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(id, promise);
    void promise.catch((error) => {
      if (!isDisposed()) report(error);
    });
    return promise;
  }
  const pendingChanges = new PendingDocumentChanges<DocumentState>(
    (doc, operation) => {
      void queue(doc, operation, true);
    },
    async (doc, text) => {
      // 重连先核对原文和版本，再发送离线输入；否则服务器重启后的版本号可能恰好相同。
      if (!connection.connected || recoveringDocuments.has(doc)) return;
      if (documentConflicts.has(doc)) throw recoveryConflict(doc);
      const base = synchronizedText.get(doc),
        tracked = changeTracks.get(doc);
      const region = tracked?.text === text && tracked.base === base?.text ? tracked.region : undefined;
      const patch = doc.supportsPatches && base?.version === doc.version ? documentTextPatch(base.text, text, region) : undefined;
      // 全文更短或基线未知时沿用旧协议；版本冲突必须保留草稿，不能用全文覆盖宿主。
      const payload = patch && JSON.stringify(patch).length < text.length ? { patch } : { text };
      // 发送前改以本次文本为基线，回执前到达的输入接着累计；发送失败时 synchronizedText 不更新，
      // 基线对不上便自动回退全文比较。记录已超前于本次文本（保存边界冻结了旧快照）时保留原记录，
      // 它的基线不再等于回执后的同步文本，下一次发送同样回退全文比较。
      if (!tracked || tracked.text === text) changeTracks.set(doc, { base: text, text });
      const result = await call<Pick<DocumentState, 'version' | 'dirty'>>('documents.update', {
        workspaceId: doc.workspaceId,
        path: doc.path,
        ...payload,
        version: doc.version,
      }).catch((error) => {
        // 失败时不能确定宿主是否接受了正文；保留草稿，后续保存先核对原基线和版本。
        recoveringDocuments.add(doc);
        throw error;
      });
      synchronizedText.set(doc, { text, version: result.version });
      doc.version = result.version;
      if (doc.text === text) doc.dirty = result.dirty;
    },
  );
  function change(doc: DocumentState, text: string, edit?: { previous: string; region: DocumentChangeRegion }) {
    const tracked = trackDocumentChange(changeTracks.get(doc), text, edit);
    if (tracked) changeTracks.set(doc, tracked);
    else changeTracks.delete(doc);
    doc.text = text;
    doc.dirty = true;
    pendingChanges.push(doc, text);
  }
  function recoverDocument(doc: DocumentState) {
    recoveringDocuments.add(doc);
    return queue(doc, async () => {
      let synchronized = false;
      try {
        if (!documents.includes(doc) || closingDocuments.has(doc)) return;
        const version = doc.version,
          base = synchronizedText.get(doc);
        const next = await call<DocumentState>('documents.open', { workspaceId: doc.workspaceId, path: doc.path, reload: true });
        if (!documents.includes(doc) || doc.version !== version) return;
        synchronized = true;
        // 已收到更新回执的脏正文也只在内存中；服务重启后不能把它当作干净缓存丢掉。
        const latest = doc.text,
          preserveDraft = doc.dirty || latest !== base?.text;
        const sameBaseline = next.baseHash === doc.baseHash;
        const sameDraft = next.version === version && next.text === base?.text;
        if (documentConflicts.has(doc) || (preserveDraft && next.text !== latest && (!sameBaseline || (next.dirty && !sameDraft)))) {
          documentConflicts.add(doc);
          doc.dirty = true;
          throw recoveryConflict(doc);
        }
        Object.assign(doc, next);
        synchronizedText.set(doc, { text: next.text, version: next.version });
        if (preserveDraft && latest !== next.text) {
          doc.text = latest;
          doc.dirty = true;
          change(doc, latest);
        }
      } finally {
        if (synchronized || !documents.includes(doc)) recoveringDocuments.delete(doc);
      }
    });
  }
  async function save(doc: DocumentState) {
    if (!connection.connected) throw new Error(t('connectionTimeout'));
    if (recoveringDocuments.has(doc)) await recoverDocument(doc);
    const synchronized = flushDocument(doc);
    await queue(doc, async () => {
      // 保存边界仍在点击时入队；此前的编辑同步失败时，不能继续把宿主旧正文保存为成功。
      await synchronized;
      if (!connection.connected) throw new Error(t('connectionTimeout'));
      if (documentConflicts.has(doc)) throw recoveryConflict(doc);
      const result = await call<DocumentState>('documents.save', {
        workspaceId: doc.workspaceId,
        path: doc.path,
        version: doc.version,
      });
      doc.baseHash = result.baseHash;
      if (doc.text === result.text) doc.dirty = result.dirty;
    });
  }

  return { documents, synchronizedText, queues, recoveringDocuments, closingDocuments, connection,
    flushDocument, flushDocuments, queue, change, recoverDocument, save };
}
