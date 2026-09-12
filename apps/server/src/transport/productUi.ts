import { PlatformPromptService } from '../prompt/service';
import { previewPrompt } from '../prompt/preview';
import { ArtifactApproval } from '../artifacts/approval';
import { CheckpointUi } from '../workspace/checkpointUi';
import { conversationUiHandlers } from '../conversations/ui';
import { inputFileHandlers } from '../workspace/uiFiles';
import { pinnedFileHandlers } from '../workspace/pinned';
import { workspaceUiHandlers } from '../workspace/ui';
import { BranchRetention } from '../conversations/retention';
import { withDependencyRuntime } from '../../../../backend/modules/dependencies/runtime';
import { validateDevelopmentSettings } from '../development/settings';
import { randomUUID } from 'node:crypto';
import { createCharacterStarterPreset } from '../../../../shared/characterPromptModules';
import { characterConversation } from '../characters/conversation';
import { memoryUiHandlers } from '../memory/ui';
import { pathToFileURL } from 'node:url';
import { ConversationManager } from '../../../../backend/modules/conversation/ConversationManager';
import { SqliteStorageAdapter } from '../../../../backend/modules/conversation/SqliteStorageAdapter';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';
import type { ProductSettingsDraft } from '../settings/product';
import { productSettingsHandlers } from './productSettings';
import { ProductChat } from './productChat';
import { SettingsTransfer } from '../settings/transfer';
import { ConversationNavigation } from '../conversations/navigation';
import { ProjectNavigation } from '../conversations/projects';
import { deleteConversation } from '../conversations/delete';
import { removePermissionAccount, resolveBotGuestActor } from '../bots/permissions';
import { activateConversationWorkspace } from '../conversations/workspace';

interface UiSession { mode?: 'chat' | 'code' | 'character'; preferences: ProductSettingsDraft; editing: boolean; workspaceId?: string }
export class ProductUi {
  readonly conversations: ConversationManager;
  readonly chat: ProductChat;
  private readonly checkpointUi: CheckpointUi;
  private readonly clients = new Map<string, Promise<UiSession>>();
  private readonly accountActions = new Map<string, 'revoke' | 'delete'>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly app: PlatformApplication) {
    this.chat = new ProductChat(app);
    this.checkpointUi = new CheckpointUi(app);
    this.conversations = new ConversationManager(new SqliteStorageAdapter(app.storage));
    app.subscribe(event => { if (event.type === 'event') this.conversations.clearMetadataCache(); });
  }
  private client(id: string): Promise<UiSession> {
    let result = this.clients.get(id);
    if (!result) { result = this.app.product.draft().then(preferences => ({ preferences, editing: false })); this.clients.set(id, result); }
    return result;
  }
  async call(client: ClientSession, type: string, data: Record<string, any> = {}): Promise<unknown> {
    // 全局统计不依赖当前工作区，也不能占住此客户端的设置与交互队列。
    if (type === 'usage.getStats') return this.app.usage.stats(client.actorId, { startTime: data.startTime, endTime: data.endTime });
    if (type.startsWith('platform.remote.')) {
      this.app.requireOwner(client.actorId);
      if (!this.app.remoteAccess) throw new Error('当前启动方式未提供远程连接管理。');
      if (type === 'platform.remote.status') return this.app.remoteAccess.status();
      if (type === 'platform.remote.token') {
        if (this.app.remoteAccess.status().source === 'command_line') return { token: await this.app.remoteAccess.accessToken() };
        const { preferences } = await this.client(client.clientId);
        const reference = preferences.app.remoteAccess?.credentialRef;
        // 切换设置分类后继续显示草稿令牌；保存后再读取已保存值。
        const token = !reference ? '' : Object.hasOwn(preferences.credentials, reference)
          ? preferences.credentials[reference] ?? '' : await this.app.settings.credential(reference) ?? '';
        return { token };
      }
      if (type === 'platform.remote.start') return this.app.remoteAccess.start();
      if (type === 'platform.remote.stop') { this.app.remoteAccess.stop(); return { success: true }; }
      if (type === 'platform.remote.revoke') { await this.app.remoteAccess.revoke(data.id); return { success: true }; }
      throw new Error('未知远程连接操作。');
    }
    if (['platform.discord.guilds', 'platform.discord.channels', 'platform.discord.user', 'platform.discord.outbox', 'platform.discord.retryDelivery'].includes(type))
      return this.invoke(client, type, data);
    if (['subagents.pauseRun', 'subagents.resumeRun', 'subagents.exitRun', 'subagents.resolveApproval', 'subagents.answerQuestion', 'subagents.monitor.requests'].includes(type))
      return this.invoke(client, type, data);
    if (['platform.accounts.revoke', 'platform.accounts.delete', 'checkpoint.cancelOperation', 'checkpoint.getOperationProgress', 'dependencies.list', 'dependencies.getInstallPath', 'dependencies.install', 'dependencies.uninstall', 'tokenizer.getResource', 'chat.awaitConversationIdle', 'chat.sendInterruptMessage', 'imageGeneration.cancel', 'terminal.kill', 'terminal.getOutput', 'terminal.detachToBackground', 'task.cancel', 'task.getAll', 'cancelStream', 'cancelSummarizeRequest', 'toolConfirmation', 'models.getModels', 'migration.cancel', 'migration.status', 'diff.accept', 'diff.reject', 'platform.questions.answer', 'platform.discord.start', 'platform.discord.stop', 'platform.discord.status', 'platform.onebot.start', 'platform.onebot.stop', 'platform.onebot.status', 'disconnectMcpServer'].includes(type))
      return this.invoke(client, type, data);
    const previous = this.queues.get(client.clientId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.invoke(client, type, data));
    this.queues.set(client.clientId, operation);
    try { return await operation; } finally { if (this.queues.get(client.clientId) === operation) this.queues.delete(client.clientId); }
  }
  private applyAccountActions(settings: ProductSettingsDraft['app']) {
    for (const [id, action] of this.accountActions) {
      if (action === 'delete') removePermissionAccount(settings, id);
      else { const account = settings.accounts.find(account => account.id === id); if (account) account.revoked = true; }
    }
  }
  private async accountAction(client: ClientSession, id: string, action: 'revoke' | 'delete') {
    this.app.requireOwner(client.actorId);
    if (!id || id === 'owner') throw new Error('不能撤销或删除主人账号。');
    const before = this.app.settings.snapshot(); const next = structuredClone(before.settings);
    const target = next.accounts.find(account => account.id === id);
    if (target) {
      if (action === 'delete') removePermissionAccount(next, id);
      else target.revoked = true;
      await this.app.settings.save({ settings: next, expectedRevision: before.revision });
    }
    this.accountActions.set(id, action);
    const after = this.app.settings.snapshot();
    for (const pending of this.clients.values()) {
      const session = await pending;
      this.applyAccountActions(session.preferences.app); this.applyAccountActions(session.preferences.baseApp);
      if (session.preferences.revision === before.revision) session.preferences.revision = after.revision;
    }
    for (const run of await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })) {
      if (run.actorId === id || resolveBotGuestActor(before.settings, run.actorId)?.permissionAccountId === id) await this.app.runtime.cancel(run.id, client.actorId);
    }
    return { success: true };
  }
  private invoke(client: ClientSession, type: string, data: Record<string, any>): Promise<unknown> {
    return withDependencyRuntime(this.app.dependencies, () => this.invokeScoped(client, type, data));
  }
  private async invokeScoped(client: ClientSession, type: string, data: Record<string, any>): Promise<unknown> {
    this.app.requireOwner(client.actorId);
    if (['plan.getSourceStatus', 'plan.confirmExecution', 'design.confirmPlanGeneration', 'review.confirmPlanGeneration'].includes(type)) return new ArtifactApproval(this.app).confirm(client.actorId, type, data);
    if (type.startsWith('characters.conversation.')) return characterConversation(this.app, client, type, data);
    const ui = await this.client(client.clientId);
    // Only refresh idle clients. An open or dirty draft retains its original CAS revision.
    if (!ui.editing && !ui.preferences.dirty && ui.preferences.revision !== this.app.settings.snapshot().revision)
      ui.preferences = await this.app.product.draft();
    const workspace = ui.workspaceId ? this.app.workspace(client.actorId, ui.workspaceId, ['workspace_read']) : undefined;
    const uri = workspace ? pathToFileURL(workspace.directory).toString() : null;
    const notify = (message: unknown) => this.app.publish({ type: 'ui.message', clientId: client.clientId, message });
    const refreshPreferences = () => {
      // 原页面分别订阅渠道、MCP 和通用设置；导入和撤销都要刷新对应的快照与缓存。
      for (const command of ['channels.configChanged', 'mcp.configChanged', 'settings.imported']) notify({ type: 'command', command, data: {} });
    };
    const checkpointHandler = this.checkpointUi.handlers(client, ui.preferences, ui.workspaceId)[type];
    if (checkpointHandler) return checkpointHandler(data);
    switch (type) {
      case 'notifications.agentStop':
      case 'notifications.preview': return { success: true, shown: false, skipped: true, reason: 'desktop_notification_unavailable' };
      case 'storagePath.migrate':
      case 'storagePath.reset':
      case 'storagePath.selectFolder': throw new Error('请在运行核心服务的桌面应用中迁移数据目录。');
      case 'countSystemPromptTokens': return new PlatformPromptService(this.app).count(client.actorId, ui.preferences, data, ui.workspaceId, client.clientId);
      case 'prompt.preview': return previewPrompt(this.app, client, data, ui.preferences, ui.workspaceId, ui.mode);
      case 'previewAttachment': return this.app.previews.show(client, data, true);
      case 'showContextContent': return this.app.previews.show(client, data, false);
      case 'preview.get': return this.app.previews.get(client, data.id);
      case 'preview.close': return this.app.previews.close(client, data.id);
      case 'conversation.getDeletedBranchCount': return new BranchRetention(this.app).count(client.actorId, data.conversationId);
      case 'conversation.pruneDeletedBranches': return new BranchRetention(this.app).prune(client.actorId, data.conversationId);
      case 'dependencies.list': return { dependencies: await this.app.dependencies.listDependencies() };
      case 'dependencies.getInstallPath': return { path: this.app.dependencies.getInstallPath() };
      case 'dependencies.install':
      case 'dependencies.uninstall': {
        if (typeof data.name !== 'string') throw new Error('请选择依赖。');
        const unsubscribe = this.app.dependencies.onProgress(event => {
          if (event.dependency === data.name) notify({ type: 'command', command: 'dependencyProgress', data: event });
        });
        try { return await this.app.dependencies[type === 'dependencies.install' ? 'install' : 'uninstall'](data.name); }
        finally { unsubscribe(); }
      }
      case 'tokenizer.getResource': {
        const name = data.name ?? 'cl100k';
        if (name !== 'cl100k' && name !== 'deepseek-v3') throw new Error('未知 tokenizer 词表。');
        return this.app.tokenizers.ensureResource(name);
      }
      case 'characters.list': return this.app.characters.list();
      case 'characters.original': return this.app.characters.original(data.id);
      case 'characters.definition': return this.app.characters.definition(data.id);
      case 'characters.get': return this.app.characters.get(data.id);
      case 'characters.import': return this.app.characters.import(data as { name: string; data: string });
      case 'characters.bind': return this.app.characters.bind(data.id, data.revision, data as any);
      case 'characters.worldbook.update': return this.app.characters.updateWorldbook(data.id, data.revision, data.raw, data.name);
      case 'characters.archive': return this.app.characters.archive(data.id, data.revision);
      case 'subagents.openMonitor': {
        if (data.conversationId) await this.app.conversation(client.actorId, data.conversationId);
        const runId = await this.app.subagentMonitor.focus(client.actorId, data.runId, data.conversationId, data.toolId);
        this.app.publish({ type: 'workspace.subagents.open', clientId: client.clientId, runId, conversationId: data.conversationId });
        return { success: true };
      }
      case 'subagents.monitorReady': return this.app.subagentMonitor.ready(client.actorId, data.conversationId, data.runId);
      case 'subagents.monitor.getRunWindow': return this.app.subagentMonitor.window(client.actorId, data.runId, data.conversationId, data.options);
      case 'subagents.monitor.requests': return this.app.subagents.requests(client.actorId, data.runId);
      case 'subagents.resolveApproval':
        if (typeof data.accepted !== 'boolean') throw new Error('请明确接受或拒绝操作。');
        return this.app.subagents.answer(client.actorId, data.runId, data.id, data.accepted);
      case 'subagents.answerQuestion': return this.app.subagents.answer(client.actorId, data.runId, data.id, data.answers);
      case 'subagents.pauseRun': return this.app.subagents.control(client.actorId, data.runId, 'pause');
      case 'subagents.resumeRun': return this.app.subagents.control(client.actorId, data.runId, 'resume');
      case 'subagents.exitRun': return this.app.subagents.control(client.actorId, data.runId, 'exit');
      case 'subagents.retryRunFromMessage': return this.app.subagentMonitor.retry(client.actorId, data.runId, data.conversationId, data.contentIndex, data.messageId, data.expectedRevision);
      case 'subagents.deleteRunMessage': return this.app.subagentMonitor.deleteMessage(client.actorId, data.runId, data.conversationId, data.contentIndex, data.messageId, data.expectedRevision);
      case 'migration.start': return this.app.migration.start(client.actorId, data.source, { conversationIds: data.conversationIds });
      case 'migration.import': {
        const result = await this.app.migration.importDirectory(client.actorId, data.source, { conversationIds: data.conversationIds });
        if (!ui.preferences.dirty) { ui.preferences = await this.app.product.draft(); refreshPreferences(); }
        return result;
      }
      case 'migration.latest': return this.app.migration.configurations.latest(client.actorId);
      case 'migration.report': {
        const result = await this.app.migration.configurations.report(client.actorId, data.operationId);
        if (!ui.preferences.dirty) { ui.preferences = await this.app.product.draft(); refreshPreferences(); }
        return result;
      }
      case 'migration.stageConfiguration': {
        const staged = await this.app.migration.configurations.stage(client.actorId, data.operationId, data.fileId, ui.preferences);
        ui.preferences = staged.draft;
        refreshPreferences();
        notify({ type: 'command', command: 'platform.appearance', data: ui.preferences.app.appearance });
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: true } }); return staged.result;
      }
      case 'migration.cancel': return this.app.migration.cancel(client.actorId);
      case 'migration.status': return this.app.migration.status(client.actorId);
      case 'migration.workspaceRoots': return this.app.migration.workspaceRoots(client.actorId, data.conversationId);
      case 'migration.bindWorkspace': return this.app.migration.bindWorkspace(client.actorId, data.conversationId, data.workspaceId, data.mapping);
      case 'settings.exportData': return new SettingsTransfer(this.app).export(ui.preferences);
      case 'settings.importData': {
        const result = await new SettingsTransfer(this.app).import(ui.preferences, data.value);
        refreshPreferences();
        notify({ type: 'command', command: 'platform.appearance', data: ui.preferences.app.appearance });
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: true } });
        return result;
      }
      case 'appearance.images.list': return this.app.images.list();
      case 'appearance.images.add': return this.app.images.add(data as any);
      case 'appearance.images.rename': await this.app.images.rename(data.id, data.name); return { success: true };
      case 'appearance.images.remove': {
        const url = `graycode://app/assets/background/${data.id}`;
        if (this.app.settings.snapshot().settings.appearance.backgroundImage === url)
          throw new Error('这张图片正在作为背景使用，请先选择其他背景并保存设置。');
        for (const pending of this.clients.values()) {
          const session = await pending;
          if (session.preferences.app.appearance.backgroundImage === url)
            throw new Error('设置草稿仍在使用这张图片，请先应用其他背景。');
        }
        await this.app.images.remove(data.id); return { success: true };
      }
      case 'activity.getStats': return this.app.activity.stats(client.actorId, data);
      case 'activity.pulse': await this.app.activity.pulse(client.actorId); return { success: true };
      case 'checkpoint.getCheckpoints': return this.app.checkpoints.summaries(client.actorId, data.conversationId);
      case 'checkpoint.previewRestore': return this.app.checkpoints.preview(client.actorId, data.conversationId, data.checkpointId);
      case 'checkpoint.deleteCheckpoint':
        return this.app.checkpoints.delete(client.actorId, data.conversationId, data.checkpointId, { force: data.force === true });
      case 'checkpoint.pruneCheckpoints':
        return this.app.checkpoints.prune(client.actorId, data.conversationId);
      case 'diff.accept': return this.app.diffs.resolve(client.actorId, data.sessionId, true);
      case 'diff.reject': return this.app.diffs.resolve(client.actorId, data.sessionId, false);
      case 'diff.loadContent': return this.app.diffs.content(client.actorId, data.diffContentId);
      case 'diff.openPreview': this.app.publish({ type: 'workspace.diff.open', toolCallId: data.toolId }); return { success: true };
      case 'ui.state.get': return await this.app.storage.getRecord('ui-state', client.actorId) ?? {};
      case 'ui.state.set': await this.app.storage.putRecord({ namespace: 'ui-state', id: client.actorId, value: data.value }); return;
      case 'ui.command': notify({ type: 'command', command: data.command, data: data.data }); return;
      case 'ui.view.set': this.app.publish({ type: 'ui.view.changed', clientId: client.clientId, view: data.view }); return;
      case 'ui.conversation.focus': {
        let conversation = data.conversationId ? await this.app.conversation(client.actorId, data.conversationId) : null;
        if (conversation) {
          try { conversation = await activateConversationWorkspace(this.app, client.actorId, conversation); }
          catch (error) { this.app.publish({ type: 'notification', clientId: client.clientId, message: `项目工作区未打开：${error instanceof Error ? error.message : String(error)}` }); }
        }
        const focusedWorkspace = this.app.settings.snapshot().settings.workspaces.find(workspace => workspace.id === conversation?.workspaceId);
        if (conversation && !data.resynchronized) ui.workspaceId = focusedWorkspace?.id;
        const focusedMode = (conversation?.custom as Record<string, unknown> | undefined)?.platformMode;
        if (typeof focusedMode === 'string' && ['chat', 'code', 'character'].includes(focusedMode)) ui.mode = focusedMode as UiSession['mode'];
        this.app.publish({ type: 'ui.conversation.focused', clientId: client.clientId, conversationId: conversation?.id ?? null, workspaceId: focusedWorkspace?.id ?? null, mode: (conversation?.custom as Record<string, unknown> | undefined)?.platformMode, resynchronized: data.resynchronized === true,
          defaultPromptModeId: this.app.settings.snapshot().settings.modeProfiles?.[ui.mode ?? 'chat']?.promptModeId ?? this.app.product.runtimeSettings().getCurrentPromptModeId() });
        return { mode: (conversation?.custom as Record<string, unknown> | undefined)?.platformMode };
      }
      case 'chat.resumeConversationStream': return this.chat.resumeConversationStream(client, data.conversationId);
      case 'conversation.navigation': return new ConversationNavigation(this.app).list(client.actorId, data);
      case 'projects.rename': return new ProjectNavigation(this.app).update(client.actorId, data, { name: data.name });
      case 'projects.previewRemoval': return new ProjectNavigation(this.app).previewRemoval(client.actorId, data);
      case 'projects.remove': return new ProjectNavigation(this.app).remove(client.actorId, data, data);
      case 'conversation.pin': return new ConversationNavigation(this.app).pin(client.actorId, data.conversationId, data.pinned === true);
      case 'conversation.rename': return new ConversationNavigation(this.app).rename(client.actorId, data.conversationId, data.title);
      case 'ui.conversation.views': {
        const views = (Array.isArray(data.views) ? data.views : []).slice(0, 100).map((item: any) => ({ id: String(item.id), conversationId: typeof item.conversationId === 'string' ? item.conversationId : null,
          title: String(item.title), isStreaming: item.isStreaming === true, hasDraft: item.hasDraft === true, active: item.active === true }));
        this.app.publish({ type: 'ui.conversation.views', clientId: client.clientId, views }); return { success: true };
      }
      case 'ui.mode.select': {
        if (!['chat', 'code', 'character'].includes(data.mode)) throw new Error('未知对话模式。');
        const preset = this.app.settings.snapshot().settings.modeProfiles?.[data.mode as 'chat' | 'code' | 'character']?.promptModeId ?? this.app.product.runtimeSettings().getCurrentPromptModeId();
        let workspaceId: string | undefined;
        if (data.conversationId) {
          await this.app.conversation(client.actorId, data.conversationId);
          if ((await this.app.storage.listRuns({ conversationId: data.conversationId, activeOnly: true, limit: 1 })).length) throw new Error('请等待当前任务结束后切换对话模式。');
          const state = await this.app.storage.readConversationState(data.conversationId);
          workspaceId = typeof state.metadata.workspaceId === 'string' ? state.metadata.workspaceId : undefined;
          const workspace = !workspaceId && data.mode === 'code' && data.workspaceId ? this.app.workspace(client.actorId, data.workspaceId, ['workspace_read']) : undefined;
          workspaceId ??= workspace?.id;
          const metadata = { ...state.metadata, ...(workspace ? { workspaceId: workspace.id, workspaceUri: pathToFileURL(workspace.directory).toString() } : {}), custom: { ...state.metadata.custom as Record<string, unknown>, platformMode: data.mode, promptModeConfig: { modeId: preset } } };
          await this.app.storage.commitConversation({ conversationId: data.conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, metadata });
          this.conversations.clearMetadataCache();
        }
        ui.mode = data.mode;
        notify({ type: 'command', command: 'platform.modeSelected', data: { mode: data.mode, promptModeId: preset } });
        return { success: true, workspaceId };
      }
      case 'ui.mode.new': {
        if (!['chat', 'code', 'character'].includes(data.mode)) throw new Error('未知对话模式。');
        ui.mode = data.mode;
        const workspaceId = data.workspaceId || undefined;
        const profile = this.app.settings.snapshot().settings.modeProfiles?.[ui.mode!];
        const preset = profile?.promptModeId ?? this.app.product.runtimeSettings().getCurrentPromptModeId();
        const conversation = await this.app.createConversation(client.actorId, data.mode === 'character' ? '新角色对话' : '新对话', workspaceId,
          { platformMode: ui.mode, promptModeConfig: { modeId: preset } }, undefined, { automaticWorkspace: true });
        return { conversationId: conversation.id };
      }
      case 'platform.modes.createCharacterPreset': {
        const preset = createCharacterStarterPreset(randomUUID());
        await ui.preferences.settings.savePromptMode(preset);
        ui.preferences.app.modeProfiles ??= {};
        ui.preferences.app.modeProfiles.character = { ...ui.preferences.app.modeProfiles.character, promptModeId: preset.id };
        ui.preferences.dirty = true;
        if (!ui.editing) await this.app.product.save(ui.preferences);
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: ui.preferences.dirty } });
        return { id: preset.id, name: preset.name };
      }
      case 'platform.development.get': return ui.preferences.app.development ?? {};
      case 'platform.development.update': {
        validateDevelopmentSettings(data.settings);
        ui.preferences.app.development = structuredClone(data.settings); ui.preferences.dirty = true;
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: true } }); return { success: true };
      }
      case 'platform.modes.get': return { profiles: ui.preferences.app.modeProfiles ?? {},
        presets: ui.preferences.settings.getAllPromptModes(), tools: this.app.tools.declarations().map(({ name }) => ({ name })) };
      case 'platform.modes.update': {
        if (!['chat', 'code', 'character'].includes(data.mode)) throw new Error('未知对话模式。');
        ui.preferences.app.modeProfiles ??= {};
        ui.preferences.app.modeProfiles[data.mode as 'chat' | 'code' | 'character'] = {
          promptModeId: typeof data.promptModeId === 'string' && data.promptModeId ? data.promptModeId : undefined,
          toolNames: Array.isArray(data.toolNames) ? data.toolNames.filter((name: unknown): name is string => typeof name === 'string') : undefined,
        };
        ui.preferences.dirty = true;
        if (!ui.editing) await this.app.product.save(ui.preferences);
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: ui.preferences.dirty } });
        return { success: true };
      }
      case 'ui.context.set':
        if (data.workspaceId) this.app.workspace(client.actorId, data.workspaceId, ['workspace_read']);
        ui.workspaceId = data.workspaceId || undefined;
        if (['chat', 'code', 'character'].includes(data.mode)) ui.mode = data.mode;
        notify({ type: 'workspaceUri', data: ui.workspaceId ? pathToFileURL(this.app.workspace(client.actorId, ui.workspaceId, []).directory).toString() : null }); return;
      case 'ui.settings.begin':
        if (!ui.editing) { ui.preferences = await this.app.product.draft(); ui.editing = true; }
        return { revision: ui.preferences.revision, dirty: ui.preferences.dirty };
      case 'ui.settings.status': return { revision: ui.preferences.revision, dirty: ui.preferences.dirty };
      case 'ui.settings.save': {
        const result = await this.app.product.save(ui.preferences);
        notify({ type: 'command', command: 'channels.configChanged', data: {} }); return result;
      }
      case 'ui.settings.discard':
        ui.preferences = await this.app.product.draft();
        notify({ type: 'command', command: 'platform.appearance', data: ui.preferences.app.appearance });
        refreshPreferences(); return { success: true };
      case 'ui.settings.end':
        if (ui.preferences.dirty) throw new Error('设置草稿尚未保存。');
        ui.editing = false; return;
      case 'platform.settings.get': return ui.preferences.app;
      case 'platform.workspaces.automaticRoot': return { directory: await this.app.conversationWorkspaces.root() };
      case 'platform.discord.status': return this.app.discord.status();
      case 'platform.discord.guilds': return { guilds: await this.app.discord.guilds() };
      case 'platform.discord.channels': return { channels: await this.app.discord.channels(data.guildId) };
      case 'platform.discord.user': return this.app.discord.user(data.userId);
      case 'platform.discord.outbox': return { messages: await this.app.discord.outbox.list() };
      case 'platform.discord.retryDelivery': return this.app.discord.outbox.retry(data.id, data.acknowledgeDuplicateRisk === true);
      case 'platform.onebot.status': return this.app.onebot.status();
      case 'platform.onebot.start': return this.app.onebot.start();
      case 'platform.onebot.stop': await this.app.onebot.stop(); return { success: true };
      case 'platform.discord.start': return this.app.discord.start();
      case 'platform.discord.stop': await this.app.discord.stop(); return { success: true };
      case 'platform.accounts.revoke': return this.accountAction(client, data.id, 'revoke');
      case 'platform.accounts.delete': return this.accountAction(client, data.id, 'delete');
      case 'platform.settings.update':
        this.applyAccountActions(data.settings);
        // 清除尚未保存的替换值；实际凭据保留，和删除凭据的 null 语义分开。
        for (const id of Array.isArray(data.clearCredentialChanges) ? data.clearCredentialChanges : [])
          if (typeof id === 'string') delete ui.preferences.credentials[id];
        ui.preferences.app = data.settings; ui.preferences.credentials = { ...ui.preferences.credentials, ...data.credentials }; ui.preferences.dirty = true;
        notify({ type: 'command', command: 'platform.appearance', data: data.settings.appearance });
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: true } }); return { success: true };
      case 'platform.reviewers.get': return {
        agents: ui.preferences.app.agents.map(({ id, name, reviewerProviderId, reviewerToolNames }) => ({ id, name, reviewerProviderId: reviewerProviderId ?? '', reviewerToolNames })),
        providers: ui.preferences.app.providers.map(({ id, name, model }) => ({ id, name, model })), tools: this.app.tools.declarations().map(({ name }) => ({ name })),
      };
      case 'platform.reviewers.update': {
        const agent = ui.preferences.app.agents.find(agent => agent.id === data.id);
        if (!agent) throw new Error('Agent 配置不存在。');
        agent.reviewerProviderId = data.reviewerProviderId || undefined;
        agent.reviewerToolNames = Array.isArray(data.reviewerToolNames) ? [...new Set(data.reviewerToolNames.filter((name: unknown): name is string => typeof name === 'string'))] as string[] : undefined;
        ui.preferences.dirty = true;
        if (!ui.editing) await this.app.product.save(ui.preferences);
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: ui.preferences.dirty } });
        return { success: true };
      }
      case 'webviewReady': this.app.publish({ type: 'ui.ready', clientId: client.clientId }); return { success: true };
      case 'checkAnnouncement': return { shouldShow: false, version: '1.5.6', changelog: '' };
      case 'getUpdateStatus':
      case 'checkUpdateNow': return { status: { state: 'unavailable', message: '请在桌面应用中检查独立版更新。' }, currentVersion: '1.5.6', runtime: 'server' };
      case 'markAnnouncementRead': await this.app.storage.putRecord({ namespace: 'ui-announcements', id: client.actorId, value: { version: data.version, readAt: Date.now() } }); return { success: true };
      case 'task.getAll': return { tasks: [...this.app.media.list(), ...this.app.terminals.list(), ...this.app.subagents.backgroundTasks(), ...(await this.app.storage.listRuns({ activeOnly: true })).map(run => ({ id: run.id,
        type: 'agent', startTime: run.createdAt, metadata: { conversationId: run.conversationId, status: run.status } }))] };
      case 'terminal.getOutput': return this.app.terminals.output(client.actorId, data.terminalId);
      case 'terminal.kill': return this.app.terminals.kill(client.actorId, data.terminalId);
      case 'terminal.detachToBackground': return this.app.terminals.detach(client.actorId, data.conversationId);
      case 'imageGeneration.cancel': return this.app.media.cancel(client.actorId, data.toolId, data.conversationId);
      case 'task.cancel': if (this.app.media.has(data.taskId)) return this.app.media.cancel(client.actorId, data.taskId, data.conversationId);
        return this.app.terminals.has(data.taskId)
        ? this.app.terminals.kill(client.actorId, data.taskId) : this.app.subagents.cancelTask(client.actorId, data.taskId);
      case 'storagePath.getConfig': return { config: ui.preferences.settings.getStoragePathConfig(),
        defaultPath: this.app.storage.directory, effectivePath: this.app.storage.directory };
      case 'getWorkspaceUri': return uri;
      case 'chatInput.focusState': return { success: true };
      case 'chatStream': return this.chat.start(client, data, ui.preferences);
      case 'retryStream': return this.chat.start(client, data, ui.preferences, 'continue');
      case 'chat.rerollStream': return this.chat.start(client, data, ui.preferences, 'reroll');
      case 'chat.editBranchStream': return this.chat.start(client, data, ui.preferences, 'edit');
      case 'summarizeContext': return this.app.context.summarizeManually(client.actorId, data.conversationId, data.configId, data.modelOverride);
      case 'cancelSummarizeRequest': return this.app.context.cancelSummary(client.actorId, data.conversationId);
      case 'restoreSummarizedMessages': return this.app.context.restoreSummary(client.actorId, data.conversationId, data.summaryMessageId);
      case 'context.editSummary': return this.app.context.editSummary(client.actorId, data.conversationId, data.summaryMessageId, data.text, data.expectedText);
      case 'context.describe': return this.app.context.describeConversation(client.actorId, data.conversationId, { providerId: data.providerId ?? data.configId, modelOverride: data.modelOverride });
      case 'context.summaryDetail': return this.app.context.getSummaryDetail(client.actorId, data.conversationId, data.messageId ?? data.summaryMessageId ?? data.id);
      case 'deleteMessage': return this.app.conversations.remove(client.actorId, data.conversationId, data.targetIndex, data.messageId, false);
      case 'deleteSingleMessage': return this.app.conversations.remove(client.actorId, data.conversationId, data.targetIndex, data.messageId, true);
      case 'conversation.getBranchGraph': return this.app.conversations.graph(client.actorId, data.conversationId);
      case 'conversation.switchBranchCandidate': return this.app.conversations.switch(client.actorId, data.conversationId, data.nodeId, data.mode ?? 'chat-only', data);
      case 'conversation.deleteBranchCandidate': return this.app.conversations.changeCandidate(client.actorId, data.conversationId, data.nodeId, 'delete');
      case 'conversation.restoreBranchCandidate': return this.app.conversations.changeCandidate(client.actorId, data.conversationId, data.nodeId, 'restore');
      case 'conversation.renameBranchCandidate': return this.app.conversations.changeCandidate(client.actorId, data.conversationId, data.nodeId, 'rename', data.label);
      case 'conversation.purgeBranchCandidate': return this.app.conversations.purgeCandidate(client.actorId, data.conversationId, data.nodeId);
      case 'chat.claimAgentMessages': {
        await this.app.conversation(client.actorId, data.conversationId);
        // 共享前端仍会询问旧扩展信箱；独立版由核心投递，不把消息交给窗口二次发送。
        return { claimId: null, conversationId: data.conversationId, message: null, messageCount: 0 };
      }
      case 'chat.releaseAgentMessages': {
        await this.app.conversation(client.actorId, data.conversationId);
        return { released: false };
      }
      case 'cancelStream': return this.chat.cancel(client, data.conversationId);
      case 'toolConfirmation': return this.chat.confirm(client, data);
      case 'platform.questions.list': {
        const list = await Promise.all(this.app.runtime.pendingQuestions().map(async question =>
          (await this.app.storage.getRun(question.runId))?.conversationId === data.conversationId ? question : null));
        return list.filter(Boolean);
      }
      case 'platform.questions.answer': await this.app.runtime.answerQuestion(data.id, client.actorId, data.answers); return { success: true };
      case 'getAppInfo': return { name: 'GrayCode', displayName: 'GrayCode', version: '1.5.6', publisher: 'Graywill', extensionId: 'Graywill.graycode', runtime: 'desktop' };
      case 'showNotification': this.app.publish({ type: 'notification', message: String(data.message), severity: data.type }); return { success: true };
      case 'conversation.createConversation': {
        if (!await this.app.storage.getConversation(data.conversationId)) {
          const mode = ui.mode ?? 'chat';
          const preset = typeof data.promptModeId === 'string' && ui.preferences.settings.getAllPromptModes().some(item => item.id === data.promptModeId)
            ? data.promptModeId : this.app.settings.snapshot().settings.modeProfiles?.[mode]?.promptModeId ?? this.app.product.runtimeSettings().getCurrentPromptModeId();
          await this.app.createConversation(client.actorId, data.title ?? '新对话', workspace?.id,
            { platformMode: mode, promptModeConfig: { modeId: preset } }, undefined, { id: data.conversationId, automaticWorkspace: true });
        }
        const created = await this.app.conversation(client.actorId, data.conversationId);
        ui.workspaceId = typeof created.workspaceId === 'string' ? created.workspaceId : undefined;
        return { success: true, workspaceId: created.workspaceId, workspaceUri: created.workspaceUri };
      }
      case 'conversation.listConversations': {
        const hidden = this.app.subagents.childConversationIds();
        return (await this.conversations.listConversations()).filter(id => !hidden.has(id));
      }
      case 'conversation.getConversationMetadata': return this.conversations.getMetadata(data.conversationId);
      case 'conversation.getConversationMetadataBatch': return this.conversations.getConversationMetadataBatch(data.conversationIds);
      case 'conversation.getMessages': return this.conversations.getHistory(data.conversationId);
      case 'conversation.getMessagesPaged': return this.conversations.getMessagesPaged(data.conversationId, { beforeIndex: data.beforeIndex, limit: data.limit });
      case 'conversation.getCustomMetadata': return this.conversations.getCustomMetadata(data.conversationId, data.key);
      case 'conversation.setCustomMetadata': await this.conversations.setCustomMetadata(data.conversationId, data.key, data.value); return { success: true };
      case 'conversation.setTitle': return new ConversationNavigation(this.app).rename(client.actorId, data.conversationId, data.title);
      case 'conversation.updateSummary': await this.conversations.updateSummary(data.conversationId, data); return { success: true };
      case 'conversation.deleteConversation': {
        await deleteConversation(this.app, client.actorId, data.conversationId); return { success: true };
      }
      case 'getOpenTabs': return { tabs: this.app.files.editorContext(client.clientId, workspace).openFiles };
      case 'getActiveEditor': return { path: this.app.files.editorContext(client.clientId, workspace).activeFile ?? null };
    }
    const handlers: Record<string, (data: Record<string, any>) => unknown> = { ...productSettingsHandlers(ui.preferences, this.app, ui.mode), ...workspaceUiHandlers(this.app, client, workspace), ...inputFileHandlers(this.app, client, workspace), ...pinnedFileHandlers(this.app, client, ui.preferences, workspace), ...conversationUiHandlers(this.app, client) };
    let handler = handlers[type];
    if (type === 'getSkillsConfig' || type === 'refreshSkills') handler = data => this.app.skills.list(client.actorId, data.conversationId, workspace?.id, ui.preferences);
    if (type === 'getSkillsDirectory') handler = () => ({ path: this.app.skills.directory() });
    if (type === 'checkSkillsExistence') handler = async data => {
      const found = await this.app.skills.items(client.actorId, data.conversationId, workspace?.id, ui.preferences);
      return { skills: (Array.isArray(data.skills) ? data.skills : []).map((skill: { id: string }) => ({ id: skill.id, exists: found.some(item => item.id === skill.id) })) };
    };
    if (type === 'setSkillEnabled' || type === 'removeSkillConfig') handler = data => {
      if (type === 'setSkillEnabled' && typeof data.enabled !== 'boolean') throw new Error('请明确启用或禁用技能。');
      return this.app.skills.change(client.actorId, data.id, type === 'setSkillEnabled' ? data.enabled : undefined,
        data.conversationId, workspace?.id, ui.preferences);
    };
    const memoryHandlers = memoryUiHandlers(this.app, client.actorId, ui.preferences);
    if (Object.hasOwn(memoryHandlers, type)) handler = memoryHandlers[type as keyof typeof memoryHandlers];
    if (handler) {
      const result = await handler(data);
      if (ui.preferences.dirty) {
        if (!ui.editing) await this.app.product.save(ui.preferences);
        notify({ type: 'command', command: 'platform.settingsDraftChanged', data: { dirty: ui.preferences.dirty } });
      }
      return result;
    }
    throw new Error(`桌面宿主尚未接入此接口：${type}`);
  }
}
