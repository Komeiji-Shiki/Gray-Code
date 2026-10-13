<script setup lang="ts">
import { computed, nextTick, defineAsyncComponent, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import type { IRange } from 'monaco-editor';
import type { DocumentState, ProjectReplacement, SourceRange } from '@graycode/contracts';
import { EditorBatchHistory, type EditBatchHandle } from '../../../../shared/editorBatchHistory';
import { call, subscribe } from '../api';
import { guard, report, state } from '../state';
import { shellText as t } from '../i18n';
import MarkdownIt from 'markdown-it';
import BrowserPane from './BrowserPane.vue';
import FileTree from './FileTree.vue';
import { useWorkbenchDocuments, workbenchDocumentKey } from '../useWorkbenchDocuments';
import type { WorkbenchDocumentModels } from '../workbenchModels';
import { useNavigationIntent } from '../navigationIntent';
import GitPanel from './GitPanel.vue';
import ProblemsPanel from './ProblemsPanel.vue';
import SearchPanel from './SearchPanel.vue';
import OutlinePanel from './OutlinePanel.vue';
import DebugPanel from './DebugPanel.vue';
import ComputerPane from './ComputerPane.vue';
import NodePane from './NodePane.vue';
import { computerState } from '../computer';
import DebugControls from './DebugControls.vue';
import { connectDebugging, toggleBreakpoint } from '../debugging';
import MobileCodeEditor from './MobileCodeEditor.vue';
import WorkbenchTabs from './WorkbenchTabs.vue';
import NavigationIcon from './navigation/NavigationIcon.vue';
import { workbenchPanels, type WorkbenchTab } from './workbenchPanels';
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const navigate = useNavigationIntent();
connectDebugging();
const TerminalPanel = defineAsyncComponent(() => import('./TerminalPanel.vue'));
const terminalSession = ref('');
const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'));
const DiffPanel = defineAsyncComponent(() => import('./DiffPanel.vue'));
const { documents, synchronizedText, queues, recoveringDocuments, closingDocuments, connection,
  flushDocument, flushDocuments, queue, change, recoverDocument, save } = useWorkbenchDocuments(() => disposed);
const editorRegistry = shallowRef<WorkbenchDocumentModels>();
let modelModule: Promise<typeof import('../workbenchModels')> | undefined;
const current = ref('');
const pane = ref('empty');
const diffTarget = ref<{ workspaceId: string; id?: string; path?: string; toolCallId?: string }>();
let openSequence = 0;
let disposed = false;
// 项目切换先使旧打开请求失效，同一事件随后发起的新打开仍能取得焦点。
watch(
  () => state.workspaceId,
  () => {
    openSequence++;
    diffTarget.value = undefined;
  },
  { flush: 'sync' },
);
const openedPanels = ref<string[]>([]);
const treeVisible = ref(localStorage.getItem('graycode.fileTreeVisible') !== 'false');
const mobileTreeVisible = ref(true);
const showingTree = computed({
  get: () => (props.compact ? mobileTreeVisible.value : treeVisible.value),
  set: (value) => {
    if (props.compact) mobileTreeVisible.value = value;
    else treeVisible.value = value;
  },
});
const savedTreeWidth = Number(localStorage.getItem('graycode.fileTreeWidth'));
const treeWidth = ref(Number.isFinite(savedTreeWidth) && savedTreeWidth > 0 ? Math.max(140, Math.min(450, savedTreeWidth)) : 220);
const treeResizing = ref(false);
const panel = ref<HTMLElement>();
const markdownPreview = ref(true);
const markdown = new MarkdownIt({ html: false, linkify: true });
const renderedMarkdown = computed(() => markdown.render(active.value?.text ?? ''));
function startTreeResize(event: PointerEvent) {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  treeResizing.value = true;
  state.panelResizing = true;
}
function moveTreeResize(event: PointerEvent) {
  if (!treeResizing.value || !panel.value) return;
  const rect = panel.value.getBoundingClientRect();
  treeWidth.value = Math.max(140, Math.min(450, rect.width - 220, event.clientX - rect.left));
}
function endTreeResize() {
  treeResizing.value = false;
  state.panelResizing = false;
  localStorage.setItem('graycode.fileTreeWidth', String(treeWidth.value));
}
watch(treeVisible, (value) => localStorage.setItem('graycode.fileTreeVisible', String(value)));
watch(pane, (value) => {
  if (!['editor', 'empty'].includes(value) && !openedPanels.value.includes(value)) openedPanels.value.push(value);
});
function activatePanel(id: string) {
  navigate({ tabId: id });
  openSequence++;
  if (!openedPanels.value.includes(id) && (id !== 'editor' || !documents.length)) openedPanels.value.push(id);
  pane.value = id;
  state.chatFocused = false;
  if (id === 'editor') showingTree.value = true;
}
watch(
  () => state.workbenchPanelRequest,
  (request) => { if (request) activatePanel(request.id); },
  { flush: 'sync' },
);
watch(
  () => computerState.openRequest,
  () => activatePanel('computer'),
);
let browserCreated = false;
let browserStarting = false;
watch(pane, (value) => {
  if (value === 'browser' && !browserCreated && !browserStarting) {
    browserStarting = true;
    void guard(async () => {
      try {
        if (isWeb) {
          await call('browser.open', { url: 'about:blank' });
          browserCreated = true;
          return;
        }
        const current = await call<{ tabs: unknown[] }>('browser.state');
        if (!current.tabs.length) await call('browser.newTab');
        browserCreated = true;
      } finally {
        browserStarting = false;
      }
    });
  }
});
const isWeb = window.graycode?.kind === 'web';
const monitorQuery = ref('');
function openMonitor(runId?: string, conversationId?: string) {
  navigate({ tabId: 'monitor' });
  openSequence++;
  const query = new URLSearchParams({ view: 'subagents' });
  if (runId) query.set('runId', runId);
  if (conversationId) query.set('conversationId', conversationId);
  monitorQuery.value = query.toString();
  pane.value = 'monitor';
  state.chatFocused = false;
}
const selections = reactive<Record<string, IRange>>({});
const closing = ref<DocumentState | null>(null);
async function readyModel(doc: DocumentState) {
  const module = await (modelModule ??= import('../workbenchModels'));
  if (disposed || !documents.includes(doc)) throw new Error(t('uiWorkbenchEditorLoadingReplacement'));
  editorRegistry.value ??= new module.WorkbenchDocumentModels({ change, flush: flushDocument,
    open: (path, workspaceId, range, focus) => open(path, workspaceId, range, focus),
  });
  return editorRegistry.value.prepare(doc).model;
}
watch(() => documents.map(doc => key(doc)), () => editorRegistry.value?.reconcile(documents));
const mobileBatchHistory = new EditorBatchHistory();
function openRange(path: string, range: SourceRange, workspaceId: string) {
  return open(path, workspaceId, {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  });
}
async function saveAll() {
  const failures: { doc: DocumentState; error: unknown }[] = [];
  for (const doc of documents) {
    try {
      await flushDocument(doc);
      if (doc.dirty) await save(doc);
    } catch (error) {
      failures.push({ doc, error });
    }
  }
  if (failures.length) {
    if (!disposed) {
      current.value = key(failures[0].doc);
      pane.value = 'editor';
      state.chatFocused = false;
      state.settingsOpen = false;
    }
    throw new Error(failures.map((item) => `${item.doc.path}: ${item.error instanceof Error ? item.error.message : String(item.error)}`).join('\n'));
  }
}
async function replaceFiles(workspaceId: string, edits: ProjectReplacement[]): Promise<EditBatchHandle> {
  await Promise.all(edits.map((edit) => open(edit.path, workspaceId, undefined, false)));
  await flushDocuments();
  const targets = edits.map((edit) => ({ edit, doc: documents.find((doc) => doc.workspaceId === workspaceId && doc.path === edit.path)! }));
  let handle: EditBatchHandle;
  if (props.compact) {
    if (targets.some(({ edit, doc }) => !doc || doc.text.replace(/^\uFEFF/, '') !== edit.before)) throw new Error(t('uiWorkbenchEditorChangedReplacement'));
    const entries = targets.map(({ edit, doc }) => {
      const before = doc.text,
        after = (before.startsWith('\uFEFF') ? '\uFEFF' : '') + edit.after;
      const target = { version: () => doc.text, disposed: () => !documents.includes(doc), undo: () => change(doc, before), redo: () => change(doc, after) };
      change(doc, after);
      return { target, before, after };
    });
    handle = mobileBatchHistory.record(entries);
  } else {
    const models = await Promise.all(targets.map(({ doc }) => readyModel(doc)));
    if (targets.some(({ edit }, index) => models[index].getValue() !== edit.before)) throw new Error(t('uiWorkbenchEditorChangedReplacement'));
    const { applyWorkspaceTextEdits } = await import('../editorWorkspaceEdits');
    // 获取模型后再次校验，加载模块期间也可能出现新输入。
    if (targets.some(({ edit }, index) => models[index].getValue() !== edit.before)) throw new Error(t('uiWorkbenchEditorChangedReplacement'));
    handle = applyWorkspaceTextEdits({
      edits: targets.map(({ edit }, index) => ({
        resource: models[index].uri,
        versionId: models[index].getVersionId(),
        textEdit: { range: models[index].getFullModelRange(), text: edit.after },
      })),
    });
  }
  await flushDocuments();
  return {
    undo: async () => {
      await handle.undo();
      await flushDocuments();
    },
    redo: async () => {
      await handle.redo();
      await flushDocuments();
    },
  };
}
const key = workbenchDocumentKey;
const active = computed(() => documents.find((doc) => key(doc) === current.value));
// 可见文档统一按视口准备，窄屏首次打开后切回桌面布局也能取得模型。
watch(() => [props.compact, active.value, pane.value] as const, ([compact, document, panel], _previous, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  if (compact || !document || panel !== 'editor') return;
  void readyModel(document).catch(error => {
    if (current && !disposed) report(error);
  });
}, { immediate: true });
const tabs = computed<WorkbenchTab[]>(() => [
  ...documents.map((doc) => ({
    id: `file:${key(doc)}`,
    label: doc.path.split(/[\\/]/).at(-1) || doc.path,
    title: doc.path,
    icon: 'file' as const,
    dirty: doc.dirty,
  })),
  ...openedPanels.value
    .filter((id) => id !== 'editor' || !documents.length)
    .map((id) => {
      const item = workbenchPanels.find((item) => item.id === id);
      return { id: `panel:${id}`, label: item?.label ?? t('uiWorkbenchSubtasks'), icon: item?.icon ?? ('chat' as const) };
    }),
]);
const activeTab = computed(() => (pane.value === 'empty' ? '' : pane.value === 'editor' && active.value ? `file:${key(active.value)}` : `panel:${pane.value}`));
const breadcrumb = computed(() => active.value?.path.split(/[\\/]/).filter(Boolean) ?? []);
const documentWorkspace = computed(() => state.snapshot?.settings.workspaces.find((workspace) => workspace.id === active.value?.workspaceId));
function selectTab(id: string) {
  navigate({ tabId: id });
  openSequence++;
  if (id.startsWith('file:')) {
    current.value = id.slice(5);
    pane.value = 'editor';
  } else pane.value = id.slice(6);
}
async function closeTab(id: string) {
  if (id.startsWith('file:')) {
    const doc = documents.find((doc) => `file:${key(doc)}` === id);
    if (doc) await close(doc);
    return;
  }
  const panel = id.slice(6);
  openedPanels.value = openedPanels.value.filter((item) => item !== panel);
  if (pane.value === panel) pane.value = documents.length ? 'editor' : (openedPanels.value.at(-1) ?? 'empty');
}
async function copyPath() {
  if (!active.value) return;
  if (isWeb) await navigator.clipboard.writeText(active.value.path);
  else await call('desktop.clipboard.writeText', { text: active.value.path });
}
async function open(path: string, workspaceId = state.workspaceId, selection?: IRange, focus = true) {
  const sequence = focus ? ++openSequence : undefined;
  const intent = focus ? navigate({ workspaceId, tabId: path }) : undefined;
  const currentIntent = () => !disposed && sequence === openSequence && intent?.current();
  try {
    if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|pdf|mp3|wav|ogg|mp4|webm)$/i.test(path)) {
      await call('browser.openFile', { workspaceId, path });
      if (props.compact && focus && currentIntent()) mobileTreeVisible.value = false;
      return;
    }
    let doc = documents.find((item) => item.workspaceId === workspaceId && item.path === path);
    if (!doc) {
      const opened = await call<DocumentState>('documents.open', { workspaceId, path });
      if (disposed) return;
      doc = documents.find((item) => key(item) === key(opened));
      if (!doc) {
        documents.push(opened);
        doc = documents[documents.length - 1];
        synchronizedText.set(doc, { text: doc.text, version: doc.version });
      }
    }
    const id = key(doc);
    if (focus && currentIntent()) {
      pane.value = 'editor';
      openedPanels.value = openedPanels.value.filter((item) => item !== 'editor');
      if (props.compact) mobileTreeVisible.value = false;
      if (selection) markdownPreview.value = false;
      current.value = id;
      if (selection) selections[id] = { ...selection };
    }
    await nextTick();
  } catch (error) {
    if (!disposed && (!focus || currentIntent())) throw error;
  }
}
// 聊天仍可保留当前代码标签，发起任务时由核心捕获此客户端的选择。
watch(
  () => [active.value?.workspaceId, active.value?.path],
  () => {
    const doc = active.value;
    if (doc && closingDocuments.has(doc)) return;
    void call('documents.focus', { workspaceId: doc?.workspaceId, path: doc?.path ?? null }).catch((error) => {
      // 连续关闭标签时，旧焦点请求可能晚于文档关闭返回，只报告当前文档的错误。
      if (active.value === doc && (!doc || !closingDocuments.has(doc))) report(error);
    });
  },
  { immediate: true },
);
function markdownLink(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a');
  const href = link?.getAttribute('href');
  if (!href || !active.value || href.startsWith('#')) return;
  event.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    void guard(() => call('browser.open', { url: href }));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  const target = new URL(href, `https://workspace.invalid/${active.value.path.replaceAll('\\', '/')}`);
  void guard(() => open(decodeURIComponent(target.pathname).replace(/^\//, ''), active.value!.workspaceId));
}
async function close(doc: DocumentState, discard = false) {
  if (current.value === key(doc)) openSequence++;
  if (doc.dirty && !discard) {
    closing.value = doc;
    return;
  }
  if (closingDocuments.has(doc)) return;
  closingDocuments.add(doc);
  try {
    await (queues.get(key(doc)) ?? Promise.resolve()).catch(() => undefined);
    if (documents.includes(doc))
      await call('documents.close', {
        workspaceId: doc.workspaceId,
        path: doc.path,
        discard,
      });
    const index = documents.indexOf(doc);
    if (index >= 0) documents.splice(index, 1);
    // 关闭回执后立即释放旧所有者，随后同路径重新打开不会借用即将销毁的模型。
    editorRegistry.value?.reconcile(documents);
    const reopened = documents.some((item) => key(item) === key(doc));
    // 删除通知或重新打开可先于关闭回执到达，只释放原文档仍拥有的界面状态。
    if (!reopened) {
      queues.delete(key(doc));
    }
    if (closing.value === doc) closing.value = null;
    if (!reopened && current.value === key(doc)) current.value = documents[index] ? key(documents[index]) : documents.at(-1) ? key(documents.at(-1)!) : '';
    if (!documents.length && pane.value === 'editor') pane.value = openedPanels.value.at(-1) ?? 'empty';
  } finally {
    closingDocuments.delete(doc);
  }
}
watch(
  () => documents.filter((doc) => doc.dirty).length,
  (count) => void guard(() => call('desktop.dirtyDocuments', { count })),
);
const unsubscribe = subscribe((event) => {
  if (event.type === 'transport.disconnected') {
    connection.connected = false;
    return;
  }
  if (event.type === 'transport.resumed') {
    const disconnected = !connection.connected;
    connection.connected = true;
    if (!disconnected && !event.snapshotRequired && !event.authenticatedAgain) return;
    for (const doc of documents) recoveringDocuments.add(doc);
    void Promise.allSettled(documents.map(recoverDocument))
      .then(() => {
        const doc = active.value;
        if (!disposed && connection.connected && doc && documents.includes(doc) && !closingDocuments.has(doc) && !recoveringDocuments.has(doc))
          return call('documents.focus', { workspaceId: doc.workspaceId, path: doc.path });
      })
      .catch((error) => {
        if (!disposed) report(error);
      });
    return;
  }
  if (event.type === 'desktop.saveAll') {
    void (async () => {
      let error: string | undefined;
      try {
        await saveAll();
        if (!disposed) await call('desktop.dirtyDocuments', { count: documents.filter((doc) => doc.dirty).length });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        if (!disposed) report(cause);
      }
      await call('desktop.saveResult', { requestId: event.requestId, participant: 'documents', error });
    })().catch((error) => {
      if (!disposed) report(error);
    });
    return;
  }
  if (event.type === 'document.reset') {
    const doc = documents.find((item) => item.workspaceId === event.workspaceId && item.path === event.path);
    if (!doc) return;
    if (typeof event.previousVersion === 'number' && doc.version > event.previousVersion) return;
    // 输入后撤销回原文字也属于本地编辑，不能仅凭正文相同接受外部重置或删除。
    const newerText = doc.dirty || doc.text !== event.previousText;
    if (event.document) {
      const previousKey = key(doc);
      const wasCurrent = current.value === previousKey;
      const text = doc.text;
      Object.assign(doc, event.document);
      synchronizedText.set(doc, { text: event.document.text, version: event.document.version });
      if (key(doc) !== previousKey) {
        if (wasCurrent) current.value = key(doc);
        const pending = queues.get(previousKey);
        queues.delete(previousKey);
        if (pending) queues.set(key(doc), pending);
        if (selections[previousKey]) {
          selections[key(doc)] = selections[previousKey];
          delete selections[previousKey];
        }
      }
      if (newerText && text !== doc.text) change(doc, text);
    } else if (!newerText) {
      documents.splice(documents.indexOf(doc), 1);
      editorRegistry.value?.reconcile(documents);
      if (current.value === key(doc)) current.value = documents.length ? key(documents[0]) : '';
      if (!event.removed) report(new Error(event.error));
    } else {
      doc.dirty = true;
      report(new Error(event.error ?? t('uiWorkbenchFileChangedKeepInput')));
    }
    return;
  }
  if (event.type === 'workspace.terminal.open') {
    terminalSession.value = event.id;
    activatePanel('terminal');
    return;
  }
  if (event.type === 'browser.opened') {
    browserCreated = true;
    activatePanel('browser');
    return;
  }
  if (event.type === 'workspace.file.open') {
    state.chatFocused = false;
    pane.value = 'editor';
    void guard(() => open(event.path, event.workspaceId, event.selection));
    return;
  }
  if (event.type === 'workspace.subagents.open') {
    openMonitor(event.runId, event.conversationId);
    return;
  }
  if (event.type === 'workspace.diff.open') {
    const workspaceId = typeof event.workspaceId === 'string' ? event.workspaceId : state.workspaceId;
    diffTarget.value = event.id || event.path || event.toolCallId ? { workspaceId, id: event.id, path: event.path, toolCallId: event.toolCallId } : undefined;
    activatePanel('diff');
    return;
  }
  if (event.type !== 'file.changed') return;
  const doc = documents.find((doc) => doc.workspaceId === event.workspaceId && doc.path === event.path);
  if (!doc || doc.dirty) return;
  void queue(doc, async () => {
    if (!documents.includes(doc) || doc.dirty || closingDocuments.has(doc)) return;
    const text = doc.text,
      version = doc.version;
    const next = await call<DocumentState>('documents.open', {
      workspaceId: doc.workspaceId,
      path: doc.path,
      reload: true,
    });
    if (!documents.includes(doc) || doc.version !== version) return;
    // 新输入已排在刷新后；先接续宿主版本，不能覆盖读盘期间的本地文本。
    const changed = doc.dirty || doc.text !== text;
    const latest = doc.text;
    Object.assign(doc, next);
    synchronizedText.set(doc, { text: next.text, version: next.version });
    if (changed) {
      doc.text = latest;
      doc.dirty = true;
    }
  });
});
onUnmounted(() => {
  disposed = true;
  editorRegistry.value?.dispose();
  openSequence++;
  unsubscribe();
});
</script>
<template>
  <section
    ref="panel"
    class="workbench side-panel"
    :class="{ 'tree-hidden': !showingTree || pane !== 'editor', 'tree-resizing': treeResizing, 'compact-workbench': compact }"
    :style="{ '--gc-tree-width': treeWidth + 'px' }"
  >
    <WorkbenchTabs
      :tabs="tabs"
      :active="activeTab"
      :editor="pane === 'editor'"
      :tree-visible="showingTree"
      :expanded="state.workbenchExpanded"
      :compact="compact"
      @select="selectTab"
      @close="(id) => guard(() => closeTab(id))"
      @add="activatePanel"
      @menu="state.panelMenuOpen = $event"
      @tree="showingTree = !showingTree"
      @expand="state.workbenchExpanded = !state.workbenchExpanded"
      @hide="state.chatFocused = true"
    />
    <button
      v-if="compact && pane === 'editor' && showingTree"
      class="file-tree-backdrop"
      :aria-label="t('uiWorkbenchCollapseFileList')"
      @click="showingTree = false"
    ></button>
    <FileTree v-show="pane === 'editor' && showingTree" @open="(path, workspaceId) => guard(() => open(path, workspaceId))" @hide="showingTree = false" />
    <div
      v-if="!compact && pane === 'editor' && showingTree"
      class="tree-splitter"
      role="separator"
      :aria-label="t('uiWorkbenchResizeFileList')"
      aria-orientation="vertical"
      :aria-valuemin="140"
      :aria-valuemax="450"
      :aria-valuenow="Math.round(treeWidth)"
      tabindex="0"
      @pointerdown.prevent="startTreeResize"
      @pointermove="moveTreeResize"
      @pointerup="endTreeResize"
      @pointercancel="endTreeResize"
      @lostpointercapture="endTreeResize"
      @keydown.left.prevent="
        treeWidth = Math.max(140, treeWidth - 10);
        endTreeResize();
      "
      @keydown.right.prevent="
        treeWidth = Math.min(450, treeWidth + 10);
        endTreeResize();
      "
    ></div>
    <div class="side-surface">
      <DebugControls @details="activatePanel('debug')" />
      <div v-if="pane === 'empty'" class="workbench-launcher">
        <div class="launcher-items">
          <p class="launcher-caption">{{ t('openPanel') }}</p>
          <button v-for="item in workbenchPanels" :key="item.id" @click="activatePanel(item.id)">
            <NavigationIcon :name="item.icon" />
            <span>{{ item.label }}</span>
            <small>{{ item.description }}</small>
            <NavigationIcon name="chevron" />
          </button>
        </div>
      </div>
      <div v-show="pane === 'editor'" class="editor-area">
        <div v-if="active" class="file-toolbar">
          <div class="file-breadcrumb" :title="documentWorkspace?.directory + '/' + active.path">
            <span class="breadcrumb-root">{{ documentWorkspace?.name }}</span>
            <template v-for="(part, index) in breadcrumb" :key="index">
              <NavigationIcon name="chevron" />
              <span :class="{ 'breadcrumb-file': index === breadcrumb.length - 1 }">{{ part }}</span>
            </template>
          </div>
          <div class="file-toolbar-actions">
            <button :title="t('uiWorkbenchCopyRelativePath')" @click="guard(copyPath)"><NavigationIcon name="copy" /></button>
            <button :title="t('uiWorkbenchSaveFileShortcut')" :class="{ 'has-changes': active.dirty }" @click="guard(() => save(active!))">
              <NavigationIcon name="save" />
              <span>{{ t('uiBrowserPaneSave') }}</span>
            </button>
            <button :title="t('uiWorkbenchSearchProjectShortcut')" @click="activatePanel('search')"><NavigationIcon name="search" /></button>
            <button v-if="documents.filter((doc) => doc.dirty).length > 1" @click="guard(saveAll)">{{ t('uiGitPanelSaveAll') }}</button>
            <button v-if="/\.md$/i.test(active.path)" @click="markdownPreview = !markdownPreview">
              {{ markdownPreview ? t('uiWorkbenchEdit') : t('uiWorkbenchPreview') }}
            </button>
            <button
              v-if="active.path.endsWith('.html')"
              @click="guard(() => call('browser.openFile', { workspaceId: active!.workspaceId, path: active!.path }))"
            >
              {{ t('uiWorkbenchPreview') }}
            </button>
          </div>
        </div>
        <div class="editors">
          <template v-if="compact">
            <MobileCodeEditor
              v-for="doc in documents"
              :key="key(doc)"
              v-show="current === key(doc) && !(markdownPreview && /\.md$/i.test(doc.path))"
              :path="doc.path"
              :value="doc.text"
              :selection="selections[key(doc)]"
              @change="(text) => change(doc, text)"
              @save="guard(() => save(doc))"
              @breakpoint="(line) => guard(() => toggleBreakpoint(doc.workspaceId, doc.path, line))"
            />
          </template>
          <CodeEditor
            v-if="!compact && active && editorRegistry"
            v-show="!(markdownPreview && /\.md$/i.test(active.path))"
            :document="active"
            :models="editorRegistry"
            :selection="selections[key(active)]"
            @save="guard(() => save(active!))"
            @problems="activatePanel('problems')"
            @outline="activatePanel('outline')"
          />
          <article
            v-if="active && markdownPreview && /\.md$/i.test(active.path)"
            class="markdown-preview"
            @click="markdownLink"
            v-html="renderedMarkdown"
          ></article>
          <div v-if="!documents.length" class="editor-empty file-select-empty">
            <NavigationIcon name="file" />
            <h2>{{ t('uiWorkbenchSelectFile') }}</h2>
            <p>{{ t('uiWorkbenchOpenDocumentHelp') }}</p>
          </div>
        </div>
      </div>
      <BrowserPane :active="pane === 'browser'" v-show="pane === 'browser'" />
      <ComputerPane
        v-if="openedPanels.includes('computer')"
        v-show="pane === 'computer'"
        :visible="pane === 'computer' && !state.chatFocused && !state.settingsOpen"
      />
      <NodePane v-if="openedPanels.includes('nodes')" v-show="pane === 'nodes'" :visible="pane === 'nodes' && !state.chatFocused && !state.settingsOpen" />
      <TerminalPanel
        v-if="openedPanels.includes('terminal')"
        :session-id="terminalSession"
        v-show="pane === 'terminal'"
        :compact="compact"
        :visible="pane === 'terminal' && !state.chatFocused && !state.settingsOpen"
      />
      <GitPanel
        v-if="openedPanels.includes('git')"
        v-show="pane === 'git'"
        :visible="pane === 'git' && !state.chatFocused && !state.settingsOpen"
        :save-all="saveAll"
        :flush="flushDocuments"
        @open="(path, workspaceId) => guard(() => open(path, workspaceId))"
      />
      <DiffPanel v-if="pane === 'diff'" :workspace-id="diffTarget?.workspaceId ?? state.workspaceId" :target="diffTarget"
        @open="(path, workspaceId) => guard(() => open(path, workspaceId))" />
      <SearchPanel
        v-if="openedPanels.includes('search')"
        v-show="pane === 'search'"
        :workspace-id="state.workspaceId"
        :flush="flushDocuments"
        :apply="replaceFiles"
        :save-all="saveAll"
        @open="(path, range, workspaceId) => guard(() => openRange(path, range, workspaceId))"
      />
      <OutlinePanel
        v-if="pane === 'outline'"
        :document="active"
        :flush="flushDocuments"
        @open="(path, range, workspaceId) => guard(() => openRange(path, range, workspaceId))"
      />
      <DebugPanel
        v-if="openedPanels.includes('debug')"
        v-show="pane === 'debug'"
        :visible="pane === 'debug'"
        :save-all="saveAll"
        :active-file="active"
        @open="
          (path, line, column, workspaceId) =>
            guard(() => open(path, workspaceId, { startLineNumber: line, endLineNumber: line, startColumn: column, endColumn: column }))
        "
      />
      <ProblemsPanel
        v-if="pane === 'problems'"
        :workspace-id="active?.workspaceId ?? state.workspaceId"
        @open="
          (path, range, workspaceId) =>
            guard(() =>
              open(path, workspaceId, {
                startLineNumber: range.start.line + 1,
                startColumn: range.start.character + 1,
                endLineNumber: range.end.line + 1,
                endColumn: range.end.character + 1,
              }),
            )
        "
      />
      <iframe
        v-if="pane === 'monitor'"
        class="monitor-frame"
        :src="'./chat/platform.html?' + (monitorQuery || 'view=subagents')"
        :title="t('uiWorkbenchSubAgentRunMonitor')"
      ></iframe>
    </div>
    <div v-if="closing" class="dialog-backdrop">
      <div class="dialog">
        <h2>{{ t('uiWorkbenchFileNotSaved') }}</h2>
        <p>{{ closing.path }}</p>
        <div class="button-row">
          <button @click="closing = null">{{ t('uiResourceLibraryKeepEditing') }}</button>
          <button @click="guard(() => close(closing!, true))">{{ t('uiWorkbenchDiscardChanges') }}</button>
          <button
            class="primary"
            @click="
              guard(async () => {
                const doc = closing!;
                await save(doc);
                await close(doc);
              })
            "
          >
            {{ t('uiWorkbenchSaveAndClose') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
<style>
.workbench.side-panel {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  grid-template-columns: minmax(140px, var(--gc-tree-width, 220px)) 4px minmax(0, 1fr);
  grid-template-rows: 44px minmax(0, 1fr);
  background: var(--gc-surface-sunken);
}
.side-panel.tree-hidden {
  grid-template-columns: minmax(0, 1fr);
}
.side-panel > .workbench-tabbar {
  grid-column: 1/-1;
}
.side-panel .file-tree {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  border: 0;
}
.tree-splitter {
  background: linear-gradient(90deg, transparent 1px, var(--gc-border-subtle) 1px, var(--gc-border-subtle) 2px, transparent 2px);
  cursor: col-resize;
  touch-action: none;
}
.tree-splitter:hover,
.tree-splitter:focus-visible {
  background: var(--gc-accent);
}
.tree-resizing {
  user-select: none;
}
.tree-resizing iframe {
  pointer-events: none;
}
.side-surface {
  grid-column: -2/-1;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.side-surface > :not(.debug-controls) {
  flex: 1;
  min-height: 0;
}
.side-surface > .debug-controls {
  flex-shrink: 0;
}
.side-surface > .editor-area {
  height: 100%;
}
.side-surface > .monitor-frame {
  height: 100%;
  width: 100%;
}
.side-panel .editors {
  min-height: 0;
}
.side-panel .editor-empty {
  min-height: 0;
}
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 14px;
  flex-shrink: 0;
}
.file-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  color: var(--gc-text-muted);
  font-size: 12px;
}
.file-breadcrumb > span {
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
.file-breadcrumb > .breadcrumb-file {
  color: var(--gc-text-primary);
  font-weight: 600;
  flex-shrink: 0;
  max-width: 65%;
}
.file-breadcrumb svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  opacity: 0.5;
}
.file-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.file-toolbar-actions button {
  display: flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--gc-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--gc-radius-sm);
  padding: 6px;
  cursor: pointer;
}
.file-toolbar-actions button:hover,
.file-toolbar-actions .has-changes {
  background: var(--gc-surface-hover);
  color: var(--gc-text-primary);
}
.file-toolbar-actions svg {
  width: 15px;
  height: 15px;
}
.workbench-launcher {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 30px;
  overflow: auto;
}
.launcher-items {
  width: min(100%, 430px);
  display: grid;
  gap: 6px;
}
.launcher-caption {
  font-size: 11px;
  color: var(--gc-text-muted);
  margin: 0 0 10px 12px;
}
.launcher-items > button {
  display: grid;
  grid-template-columns: 18px 1fr auto 12px;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 46px;
  padding: 12px 14px;
  background: var(--gc-surface-raised);
  border: 1px solid transparent;
  border-radius: var(--gc-radius-sm);
  text-align: left;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.launcher-items > button:hover {
  background: var(--gc-surface-hover);
  border-color: var(--gc-border-control);
}
.launcher-items svg {
  width: 16px;
  height: 16px;
  color: var(--gc-text-muted);
}
.launcher-items svg:last-child {
  width: 11px;
  height: 11px;
  opacity: 0.5;
}
.launcher-items small {
  font-size: 11px;
  color: var(--gc-text-muted);
}
.file-select-empty > svg {
  width: 34px;
  height: 34px;
  opacity: 0.3;
  margin-bottom: 10px;
}
.side-panel .file-select-empty h2 {
  font-size: 16px;
  font-weight: 500;
}
.side-panel .file-select-empty p {
  font-size: 12px;
}
.markdown-preview {
  height: 100%;
  overflow: auto;
  padding: 24px 30px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.markdown-preview pre {
  overflow: auto;
  background: var(--gc-surface-raised);
  padding: 15px;
  white-space: pre;
}
.markdown-preview table {
  border-collapse: collapse;
}
.markdown-preview td,
.markdown-preview th {
  padding: 8px;
  border: 1px solid var(--gc-border-subtle);
}
.markdown-preview img {
  max-width: 100%;
}
.side-surface > .terminal-panel {
  height: 100%;
  min-height: 0;
}
.compact-workbench.side-panel {
  position: relative;
  grid-template-columns: minmax(0, 1fr);
}
.compact-workbench > .file-tree {
  position: absolute;
  inset: 44px auto 0 0;
  width: min(330px, 92%);
  z-index: 12;
  background: var(--gc-surface-raised);
  border-right: 1px solid var(--gc-border-subtle);
}
.file-tree-backdrop {
  position: absolute;
  inset: 44px 0 0;
  background: var(--gc-backdrop);
  border: 0;
  z-index: 11;
}
.file-tree-backdrop:hover {
  background: var(--gc-backdrop);
}
.compact-workbench .side-surface {
  grid-column: 1;
  grid-row: 2;
}
.compact-workbench .markdown-preview {
  padding: 16px;
}
.compact-workbench .editor-empty {
  padding: 18px;
}
.compact-workbench .file-toolbar {
  padding-inline: 9px;
}
.compact-workbench .file-toolbar-actions button span {
  display: none;
}
.compact-workbench .workbench-launcher {
  padding: 20px;
}
.compact-workbench .launcher-items small {
  display: none;
}
</style>
