import { onUnmounted, reactive, watch } from 'vue';
import type { DocumentState } from '@graycode/contracts';
import { documentTextPatch, trackDocumentChange, type DocumentChangeRegion, type TrackedDocumentChange } from '../../../shared/documentPatch';
import { PendingDocumentChanges } from './pendingDocumentChanges';
import { call, subscribe } from './api';
import { report } from './state';
import { shellText as t } from './i18n';

export const workbenchDocumentKey = (document: Pick<DocumentState, 'workspaceId' | 'path'>) => `${document.workspaceId}:${document.path}`;

export type WorkbenchDocumentChange =
  | { type: 'renamed'; document: DocumentState; previousKey: string }
  | { type: 'removed' | 'closed'; document: DocumentState; index: number; reopened: boolean };

interface WorkbenchDocumentOptions {
  disposed(): boolean;
  changed(change: WorkbenchDocumentChange): void;
  saveFailed(document: DocumentState): void;
}
interface PendingDocumentOpen {
  workspaceId: string; valid: boolean; resets: Record<string, unknown>[]; changedPaths: Set<string>;
  closedKeys: Set<string>;
}
type DocumentResetResult =
  | { kind: 'unchanged' }
  | { kind: 'removed'; error?: Error }
  | { kind: 'updated'; document: DocumentState; synchronized?: { text: string; version: number }; resendText?: string; error?: Error };

/** 文档同步、保存与断线恢复共用同一队列，不随可见编辑器切换而重建。 */
export function useWorkbenchDocuments(options: WorkbenchDocumentOptions) {
  const isDisposed = options.disposed;
  const key = workbenchDocumentKey;
  const documents = reactive<DocumentState[]>([]);
  const synchronizedText = new WeakMap<DocumentState, { text: string; version: number }>();
  const changeTracks = new WeakMap<DocumentState, TrackedDocumentChange>();
  const queues = new Map<string, Promise<unknown>>();
  const recoveringDocuments = new Set<DocumentState>();
  const documentConflicts = new WeakSet<DocumentState>();
  const closingDocuments = new Set<DocumentState>();
  const pendingOpens = new Set<PendingDocumentOpen>();
  let connected = true;
  let focusedDocument: DocumentState | undefined;
  const recoveryConflict = (doc: DocumentState) => new Error(`${doc.path}: ${t('documentRecoveryConflict')}`);
  function flushDocument(doc: DocumentState) {
    return queues.get(key(doc)) ?? Promise.resolve();
  }
  async function flushDocuments() {
    await Promise.all(documents.map(flushDocument));
  }
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
      if (!connected || recoveringDocuments.has(doc)) return;
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
    if (!connected) throw new Error(t('connectionTimeout'));
    if (recoveringDocuments.has(doc)) await recoverDocument(doc);
    const synchronized = flushDocument(doc);
    await queue(doc, async () => {
      // 保存边界仍在点击时入队；此前的编辑同步失败时，不能继续把宿主旧正文保存为成功。
      await synchronized;
      if (!connected) throw new Error(t('connectionTimeout'));
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

  async function open(path: string, workspaceId: string): Promise<DocumentState | undefined> {
    const existing = documents.find(document => document.workspaceId === workspaceId && document.path === path);
    if (existing) return existing;
    const pending: PendingDocumentOpen = { workspaceId, valid: true, resets: [], changedPaths: new Set(), closedKeys: new Set() };
    pendingOpens.add(pending);
    try {
      const opened = await call<DocumentState>('documents.open', { workspaceId, path });
      if (isDisposed() || !connected || !pending.valid) return;
      let current = opened;
      let synchronized = { text: opened.text, version: opened.version };
      let resendText: string | undefined;
      let error: Error | undefined;
      const identities = new Set([key(opened)]);
      // 先确定最终身份再登记，多个旧路径回执不能因移动回放建立重复文档。
      for (const event of pending.resets) {
        if (current.workspaceId !== event.workspaceId || current.path !== event.path) continue;
        const result = resetResult(current, event);
        if (result.kind === 'unchanged') continue;
        if (result.kind === 'removed') { if (result.error) throw result.error; return; }
        current = result.document;
        identities.add(key(current));
        if (result.synchronized) { synchronized = result.synchronized; resendText = result.resendText; }
        error = result.error;
      }
      if ([...identities].some(identity => pending.closedKeys.has(identity))) return;
      const concurrent = documents.find(document => key(document) === key(current));
      if (concurrent) return concurrent;
      documents.push(current);
      const document = documents[documents.length - 1];
      synchronizedText.set(document, synchronized);
      if (resendText !== undefined) change(document, resendText);
      if (error) report(error);
      if (pending.changedPaths.has(document.path)) refreshFile(document.workspaceId, document.path);
      return document;
    } catch (error) {
      if (!isDisposed() && pending.valid) throw error;
    } finally { pendingOpens.delete(pending); }
  }

  async function close(document: DocumentState, discard: boolean): Promise<void> {
    if (closingDocuments.has(document)) return;
    closingDocuments.add(document);
    const pendingBeforeClose = [...pendingOpens].filter(pending => pending.workspaceId === document.workspaceId);
    const closedKeys = new Set([key(document)]);
    try {
      await flushDocument(document).catch(() => undefined);
      if (documents.includes(document)) {
        closedKeys.add(key(document));
        await call('documents.close', { workspaceId: document.workspaceId, path: document.path, discard });
      }
      closedKeys.add(key(document));
      for (const pending of pendingBeforeClose) if (pendingOpens.has(pending)) {
        for (const identity of closedKeys) pending.closedKeys.add(identity);
      }
      const index = documents.indexOf(document);
      if (index >= 0) documents.splice(index, 1);
      const reopened = documents.some(item => key(item) === key(document));
      if (!reopened) queues.delete(key(document));
      options.changed({ type: 'closed', document, index, reopened });
    } finally {
      closingDocuments.delete(document);
    }
  }

  function focus(document: DocumentState | undefined): void {
    focusedDocument = document;
    if (document && closingDocuments.has(document)) return;
    void call('documents.focus', { workspaceId: document?.workspaceId, path: document?.path ?? null }).catch(error => {
      // 焦点与关闭可并发，旧请求的错误只属于当时选中的文档。
      if (!isDisposed() && focusedDocument === document && (!document || !closingDocuments.has(document))) report(error);
    });
  }

  async function saveAll(): Promise<void> {
    const failures: { document: DocumentState; error: unknown }[] = [];
    for (const document of documents) {
      try {
        await flushDocument(document);
        if (document.dirty) await save(document);
      } catch (error) {
        failures.push({ document, error });
      }
    }
    if (failures.length) {
      if (!isDisposed()) options.saveFailed(failures[0].document);
      throw new Error(failures.map(({ document, error }) =>
        `${document.path}: ${error instanceof Error ? error.message : String(error)}`).join('\n'));
    }
  }

  function reset(event: Record<string, unknown>): void {
    for (const pending of pendingOpens) if (pending.workspaceId === event.workspaceId) pending.resets.push(event);
    const document = documents.find(item => item.workspaceId === event.workspaceId && item.path === event.path);
    if (!document) return;
    applyReset(document, event);
  }

  function resetResult(document: DocumentState, event: Record<string, any>): DocumentResetResult {
    if (typeof event.previousVersion === 'number' && document.version > event.previousVersion) return { kind: 'unchanged' };
    const newerText = document.dirty || document.text !== event.previousText;
    if (event.document) {
      const next: DocumentState = { ...document, ...event.document };
      const resendText = newerText && document.text !== next.text ? document.text : undefined;
      if (resendText !== undefined) { next.text = resendText; next.dirty = true; }
      return { kind: 'updated', document: next, resendText,
        synchronized: { text: event.document.text, version: event.document.version } };
    }
    if (!newerText) return { kind: 'removed', error: event.removed ? undefined : new Error(event.error) };
    return { kind: 'updated', document: { ...document, dirty: true },
      error: new Error(event.error ?? t('uiWorkbenchFileChangedKeepInput')) };
  }

  function applyReset(document: DocumentState, event: Record<string, unknown>): void {
    const result = resetResult(document, event);
    if (result.kind === 'unchanged') return;
    if (result.kind === 'removed') {
      const index = documents.indexOf(document);
      documents.splice(index, 1);
      options.changed({ type: 'removed', document, index, reopened: false });
    } else {
      const previousKey = key(document);
      Object.assign(document, result.document);
      if (result.synchronized) synchronizedText.set(document, result.synchronized);
      if (key(document) !== previousKey) {
        const pending = queues.get(previousKey);
        queues.delete(previousKey);
        if (pending) queues.set(key(document), pending);
        options.changed({ type: 'renamed', document, previousKey });
      }
      if (result.resendText !== undefined) change(document, result.resendText);
    }
    if (result.error) report(result.error);
  }

  function refreshFile(workspaceId: string, path: string): void {
    for (const pending of pendingOpens) if (pending.workspaceId === workspaceId) pending.changedPaths.add(path);
    const document = documents.find(item => item.workspaceId === workspaceId && item.path === path);
    if (!document || document.dirty) return;
    void queue(document, async () => {
      if (!documents.includes(document) || document.dirty || closingDocuments.has(document)) return;
      const text = document.text;
      const version = document.version;
      const next = await call<DocumentState>('documents.open', { workspaceId, path, reload: true });
      if (!documents.includes(document) || document.version !== version) return;
      const changed = document.dirty || document.text !== text;
      const latest = document.text;
      Object.assign(document, next);
      synchronizedText.set(document, { text: next.text, version: next.version });
      if (changed) {
        document.text = latest;
        document.dirty = true;
      }
    });
  }

  watch(() => documents.filter(document => document.dirty).length, count => {
    void call('desktop.dirtyDocuments', { count }).catch(report);
  });
  function invalidatePendingOpens(): void {
    for (const pending of pendingOpens) {
      pending.valid = false;
      pending.resets.length = 0;
      pending.changedPaths.clear();
      pending.closedKeys.clear();
    }
    pendingOpens.clear();
  }
  const unsubscribe = subscribe(event => {
    if (event.type === 'transport.disconnected') {
      connected = false;
      invalidatePendingOpens();
    } else if (event.type === 'transport.resumed') {
      const disconnected = !connected;
      connected = true;
      if (!disconnected && !event.snapshotRequired && !event.authenticatedAgain) return;
      invalidatePendingOpens();
      for (const document of documents) recoveringDocuments.add(document);
      void Promise.allSettled(documents.map(recoverDocument)).then(() => {
        const document = focusedDocument;
        if (!isDisposed() && connected && document && documents.includes(document)
          && !closingDocuments.has(document) && !recoveringDocuments.has(document)) focus(document);
      });
    } else if (event.type === 'document.reset') {
      reset(event);
    } else if (event.type === 'file.changed') {
      refreshFile(event.workspaceId, event.path);
    } else if (event.type === 'desktop.saveAll') {
      void (async () => {
        let error: string | undefined;
        try {
          await saveAll();
          if (!isDisposed()) await call('desktop.dirtyDocuments', { count: documents.filter(document => document.dirty).length });
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          if (!isDisposed()) report(cause);
        }
        await call('desktop.saveResult', { requestId: event.requestId, participant: 'documents', error });
      })().catch(error => {
        if (!isDisposed()) report(error);
      });
    }
  });
  onUnmounted(() => { invalidatePendingOpens(); unsubscribe(); });

  return {
    documents: documents as readonly DocumentState[],
    open,
    close,
    focus,
    flushDocument,
    flushDocuments,
    change,
    save,
    saveAll,
  };
}
