import { gitRequest } from './git';
import { debugRequest } from './debugging';
import { longMemoryRequest } from './longMemory';
import { workspaceDirectoryKey } from '../workspace/identity';
import { ProjectNavigation } from '../conversations/projects';
import type { PlatformApplication } from "../application";
import type { SettingsDraft, StartRunInput, WorkspaceDefinition } from "@graycode/contracts";
import { randomUUID } from "node:crypto";

export interface ClientSession {
  actorId: string;
  clientId: string;
}
export class ApplicationRouter {
  constructor(private readonly application: PlatformApplication) {}
  async call(
    session: ClientSession,
    method: string,
    params: Record<string, any> = {},
  ): Promise<unknown> {
    const app = this.application;
    if (!app.actor(session.actorId)) throw new Error("Account is unavailable.");
    if (method.startsWith('git.')) return gitRequest(app, session, method, params);
    if (method.startsWith('debug.')) return debugRequest(app, session, method, params);
    if (method.startsWith('memory.')) return longMemoryRequest(app, session, method, params);
    if (method.startsWith('computer.')) return app.computer.call(session, method, params);
    if (method.startsWith('automations.')) {
      switch (method) {
        case 'automations.options': return app.automations.options(session.actorId, params.conversationId);
        case 'automations.list': return app.automations.list(session.actorId);
        case 'automations.create': return app.automations.create(session.actorId, params as unknown as import('@graycode/contracts').AutomationCreate);
        case 'automations.update': return app.automations.update(session.actorId, params.id, params as unknown as import('@graycode/contracts').AutomationCreate);
        case 'automations.pause': return app.automations.pause(session.actorId, params.id, params.stopCurrent === true);
        case 'automations.resume': return app.automations.resume(session.actorId, params.id);
        case 'automations.remove': await app.automations.remove(session.actorId, params.id); return { success: true };
        default: throw new Error('未知自动任务操作。');
      }
    }
    if (method.startsWith('remote.')) {
      app.requireOwner(session.actorId);
      if (!app.remoteAccess) throw new Error('当前启动方式未提供远程连接管理。');
      switch (method) {
        case 'remote.status': return app.remoteAccess.status();
        case 'remote.start': return app.remoteAccess.start();
        case 'remote.stop': app.remoteAccess.stop(); return { success: true };
        case 'remote.revoke': await app.remoteAccess.revoke(params.id); return { success: true };
        default: throw new Error('未知远程连接操作。');
      }
    }
    if (method.startsWith('terminal.')) {
      app.requireOwner(session.actorId);
      const terminals = app.interactiveTerminals;
      switch (method) {
        case 'terminal.list': return terminals.list();
        case 'terminal.snapshot': return terminals.snapshot(params.id);
        case 'terminal.create': return terminals.create(session.actorId, params.workspaceId, params.cols, params.rows, params.directory);
        case 'terminal.input': return terminals.input(params.id, params.data);
        case 'terminal.resize': return terminals.resize(params.id, params.cols, params.rows);
        case 'terminal.stop': return terminals.stop(params.id);
        case 'terminal.close': return terminals.remove(params.id);
        default: throw new Error('未知终端操作。');
      }
    }
    if (method.startsWith('browser.')) {
      app.requireOwner(session.actorId);
      if (!app.browser) throw new Error('当前设备没有内置浏览器宿主。');
      return app.browser.call(session.actorId, method, params);
    }
    if (method === 'ui.request') return app.productUi.call(session, params.type, params.data);
    if (method.startsWith('ui.')) return app.productUi.call(session, method, params);
    switch (method) {
      case 'terminals.list': app.requireOwner(session.actorId); return app.terminals.list();
      case 'terminals.output': app.requireOwner(session.actorId); return app.terminals.output(session.actorId, params.id);
      case 'terminals.stop': app.requireOwner(session.actorId); return app.terminals.kill(session.actorId, params.id);
      case 'terminals.detach': app.requireOwner(session.actorId); return app.terminals.detach(session.actorId, params.conversationId);
      case 'migration.start': return app.migration.start(session.actorId, String(params.source), { conversationIds: params.conversationIds });
      case 'migration.import': return app.migration.importDirectory(session.actorId, String(params.source), { conversationIds: params.conversationIds });
      case 'migration.cancel': return app.migration.cancel(session.actorId);
      case 'migration.status': return app.migration.status(session.actorId);
      case 'migration.workspaceRoots': return app.migration.workspaceRoots(session.actorId, params.conversationId);
      case 'migration.bindWorkspace': return app.migration.bindWorkspace(session.actorId, params.conversationId, params.workspaceId, params.mapping);
      case 'activity.pulse': await app.activity.pulse(session.actorId); return { success: true };
      case 'activity.getStats': return app.activity.stats(session.actorId, params);
      case 'workspaces.add': {
        app.requireOwner(session.actorId);
        const snapshot = app.settings.snapshot();
        const existing = snapshot.settings.workspaces.find(item => workspaceDirectoryKey(item.directory) === workspaceDirectoryKey(params.directory) && JSON.stringify(item.roots ?? null) === JSON.stringify(params.roots ?? null));
        if (existing) {
          if (existing.managedConversationId) {
            delete existing.managedConversationId; existing.name = String(params.name || existing.name);
            await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
          }
          await new ProjectNavigation(app).restore(session.actorId, { workspaceId: existing.id });
          return existing;
        }
        const workspace: WorkspaceDefinition = { id: randomUUID(), deviceId: 'local', name: String(params.name || '工作区'), directory: String(params.directory), ...(params.roots !== undefined ? { roots: params.roots } : {}) };
        snapshot.settings.workspaces.push(workspace);
        const saved = await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
        await new ProjectNavigation(app).restore(session.actorId, { workspaceId: workspace.id });
        return saved.settings.workspaces.find(item => item.id === workspace.id);
      }
      case 'workspace.checkpoints.list':
        app.requireOwner(session.actorId);
        return app.checkpoints.summaries(session.actorId, params.conversationId);
      case 'workspace.checkpoints.create':
        app.requireOwner(session.actorId);
        return app.checkpoints.create(session.actorId, params.conversationId, { name: params.name });
      case 'workspace.checkpoints.preview':
        app.requireOwner(session.actorId);
        return app.checkpoints.preview(session.actorId, params.conversationId, params.checkpointId);
      case 'workspace.checkpoints.restore':
        app.requireOwner(session.actorId);
        return app.checkpoints.restore(session.actorId, params.conversationId, params.checkpointId, params);
      case 'workspace.checkpoints.delete':
        app.requireOwner(session.actorId);
        return app.checkpoints.delete(session.actorId, params.conversationId, params.checkpointId, { force: params.force === true });
      case 'workspace.checkpoints.prune':
        app.requireOwner(session.actorId);
        return app.checkpoints.prune(session.actorId, params.conversationId);
      case 'workspace.diffs.list':
        app.requireOwner(session.actorId);
        return app.diffs.list(session.actorId, params.workspaceId);
      case 'workspace.diffs.resolve':
        app.requireOwner(session.actorId);
        if (typeof params.accepted !== 'boolean') throw new Error('需要明确接受或拒绝修改。');
        return app.diffs.resolve(session.actorId, params.id, params.accepted);
      case 'workspace.operations.recover':
        app.requireOwner(session.actorId);
        return app.changes.recover();
      case 'workspace.operations.pending': {
        app.requireOwner(session.actorId);
        const ids = await app.storage.listRecords('workspace-operations');
        return Promise.all(ids.map(async id => {
          const value = await app.storage.getRecord('workspace-operations', id) as { id: string; conversationId: string; workspace: { id: string }; changes: { path: string }[] };
          return { id: value.id, conversationId: value.conversationId, workspaceId: value.workspace.id, paths: value.changes.map(change => change.path) };
        }));
      }
      case "session.info":
        return {
          actor: app.actor(session.actorId),
          clientId: session.clientId,
        };
      case "settings.get":
        app.requireOwner(session.actorId);
        return app.settings.snapshot();
      case "settings.save":
        app.requireOwner(session.actorId);
        return app.settings.save(params as SettingsDraft);
      case "discord.status":
        app.requireOwner(session.actorId);
        return app.discord.status();
      case 'onebot.status': app.requireOwner(session.actorId); return app.onebot.status();
      case 'onebot.start': app.requireOwner(session.actorId); return app.onebot.start();
      case 'onebot.stop': app.requireOwner(session.actorId); await app.onebot.stop(); return { success: true };
      case "discord.start":
        app.requireOwner(session.actorId);
        return app.discord.start();
      case "discord.stop":
        app.requireOwner(session.actorId);
        return app.discord.stop();
      case "tools.list":
        return app.tools.declarations();
      case "conversations.create":
        return app.createConversation(
          session.actorId,
          String(params.title ?? "新对话"),
          params.workspaceId,
        );
      case "conversations.list": {
        const list = await app.storage.listConversations({
          limit: Math.min(200, Number(params.limit ?? 100)),
          cursor: params.cursor,
        });
        const hidden = app.subagents.childConversationIds();
        list.items = list.items.filter(item => !hidden.has(item.id));
        if (app.actor(session.actorId)?.role === "owner") return list;
        const accessible = await Promise.all(
          list.items.map(async (item) =>
            (await app.storage.getConversation(item.id))?.actorId ===
            session.actorId
              ? item
              : null,
          ),
        );
        return { ...list, items: accessible.filter(Boolean) };
      }
      case "conversations.history":
        await app.conversation(session.actorId, params.id);
        return app.storage.readHistory(params.id, {
          limit: params.limit ?? 100,
          beforeIndex: params.beforeIndex,
        });
      case "conversations.get":
        return app.conversation(session.actorId, params.id);
      case 'conversations.branches': return app.conversations.graph(session.actorId, params.id);
      case 'conversations.branch.switch': return app.conversations.switch(session.actorId, params.id, params.nodeId, params.mode ?? 'chat-only', params);
      case 'conversations.messages.delete': return app.conversations.remove(session.actorId, params.id, params.index, params.messageId, params.single === true);
      case 'conversations.snapshots.list':
        await app.conversation(session.actorId, params.id); return app.storage.listSnapshots(params.id);
      case 'conversations.snapshots.restore': return app.conversations.restoreSnapshot(session.actorId, params.id, params.snapshotId, params.expectedRevision);
      case 'runs.continue': {
        const conversation = await app.conversation(session.actorId, params.conversationId);
        return app.runtime.continue({ actorId: session.actorId, conversationId: conversation.id, agentId: params.agentId,
          workspaceId: conversation.workspaceId as string | undefined, requestKey: params.requestKey, expectedRevision: params.expectedRevision,
          providerId: params.providerId, modelOverride: params.modelOverride, reasoningEffort: params.reasoningEffort, promptModeId: params.promptModeId }, undefined, { clientId: session.clientId });
      }
      case "conversations.rename": {
        const current = await app.manageConversation(session.actorId, params.id);
        return app.storage.saveMetadata({
          ...current,
          title: String(params.title),
          updatedAt: Date.now(),
        });
      }
      case "conversations.fork": {
        const current = await app.conversation(session.actorId, params.id);
        const now = Date.now();
        const target = {
          ...current,
          id: randomUUID(),
          actorId: session.actorId,
          title: String(params.title ?? `${current.title} · 分支`),
          createdAt: now,
          updatedAt: now,
        };
        return app.storage.forkConversation(current.id, target, {
          beforeIndex: params.beforeIndex,
          expectedRevision: params.expectedRevision,
        });
      }
      case "runs.start": {
        const conversation = await app.conversation(
          session.actorId,
          params.conversationId,
        );
        if (
          params.workspaceId !== undefined &&
          params.workspaceId !== conversation.workspaceId
        )
          throw new Error(
            "A conversation keeps its original workspace. Create a new conversation to change it.",
          );
        const input: StartRunInput = {
          actorId: session.actorId,
          conversationId: conversation.id,
          requestKey: String(params.requestKey),
          agentId: String(params.agentId),
          workspaceId: conversation.workspaceId as string | undefined,
          message: {
            role: "user",
            parts: [{ text: String(params.text ?? "") }],
          },
          ...(params.providerId ? { providerId: params.providerId } : {}),
          ...(params.modelOverride
            ? { modelOverride: params.modelOverride }
            : {}),
          ...(params.reasoningEffort
            ? { reasoningEffort: params.reasoningEffort }
            : {}),
        };
        if (!params.requestKey || !String(params.text ?? "").trim())
          throw new Error("Supply a unique request key and a message.");
        if (conversation.title === "新对话") {
          const history = await app.storage.historyInfo(conversation.id);
          if (history.total === 0) await app.storage.saveMetadata({ ...conversation,
            title: String(params.text).trim().replace(/\s+/g, " ").slice(0, 48), updatedAt: Date.now() });
        }
        return app.runtime.start(input, undefined, { clientId: session.clientId });
      }
      case "runs.list":
        return app.storage.listRuns({
          conversationId: params.conversationId,
          actorId:
            app.actor(session.actorId)?.role === "owner"
              ? undefined
              : session.actorId,
          activeOnly: params.activeOnly,
          limit: 100,
        });
      case "runs.events": {
        const run = await app.storage.getRun(params.id);
        if (!run) throw new Error("Run not found.");
        await app.conversation(session.actorId, run.conversationId);
        return app.storage.readRunEvents(params.id, params.afterSequence);
      }
      case 'runs.request': {
        const run = await app.storage.getRun(params.id);
        if (!run) throw new Error('Run not found.');
        await app.conversation(session.actorId, run.conversationId);
        if (!Number.isSafeInteger(params.iteration) || params.iteration < 1) throw new Error('请选择模型调用轮次。');
        return app.storage.getRecord('model-requests', `${run.id}:${params.iteration}`);
      }
      case "runs.cancel":
        return app.runtime.cancel(params.id, session.actorId);
      case "approvals.list":
        app.requireOwner(session.actorId);
        return app.runtime.pendingApprovals();
      case "approvals.resolve":
        return app.runtime.resolveApproval(
          params.id,
          session.actorId,
          params.accepted === true,
        );
      case "questions.list":
        return app.runtime
          .pendingQuestions()
          .filter(
            (question) =>
              app.actor(session.actorId)?.role === "owner" ||
              question.actorId === session.actorId,
          );
      case "questions.answer":
        return app.runtime.answerQuestion(
          params.id,
          session.actorId,
          params.answers,
        );
      case 'files.search': return app.workspaceSearch.search(session, params.workspaceId, params.requestId, params.options);
      case 'files.searchCancel': app.requireOwner(session.actorId); return app.workspaceSearch.cancel(session, params.requestId);
      case 'files.replacePreview': return app.workspaceSearch.replace(session, params.workspaceId, params.options, params.replacement, params.files);
      case 'files.inspect': return app.fileActions.inspect(session.actorId, params.workspaceId, params.path);
      case 'files.downloadInfo': {
        const { absolute: _absolute, ...info } = await app.fileActions.download(session.actorId, params.workspaceId, params.path); return info;
      }
      case 'files.create': return app.fileActions.create(session.actorId, params.workspaceId, params.path, params.kind);
      case 'files.move': return app.fileActions.move(session.actorId, params.workspaceId, params.path, params.target, params.expectedVersion);
      case 'files.remove': return app.fileActions.remove(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.recursive === true);
      case 'files.upload': return app.fileActions.upload(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.bytes);
      case "files.list":
        app.requireOwner(session.actorId);
        return app.files.list(
          app.workspace(session.actorId, params.workspaceId, [
            "workspace_read",
          ]),
          params.path,
        );
      case 'language.list': return app.languages.list(session, params.refresh === true);
      case 'language.ensure': return app.languages.ensure(session, params.workspaceId, params.path);
      case 'language.request': return app.languages.request(session, params as any);
      case 'language.executeCommand': return app.languages.executeCommand(session, params as any);
      case 'language.applyEditResult': return app.languages.completeEditorEdit(session, params.id, params.result);
      case 'language.cancel': return app.languages.cancel(session, params.requestId);
      case 'language.path': return app.languages.relativePath(session, params.workspaceId, params.uri);
      case 'language.diagnostics': return app.languages.diagnostics(session, params.workspaceId);
      case 'language.restart': return app.languages.restart(session, params.id);
      case 'language.stop': return app.languages.stop(session, params.id);
      case 'documents.open': {
        app.requireOwner(session.actorId);
        const doc = await app.files.openDocument(app.workspace(session.actorId, params.workspaceId, ['workspace_read']), params.path, session.clientId);
        app.languages.documentChanged(doc); return doc;
      }
      case 'documents.focus': {
        app.requireOwner(session.actorId);
        if (params.path === null) { app.files.focusDocument(session.clientId); return; }
        if (typeof params.path !== 'string' || typeof params.workspaceId !== 'string') throw new Error('当前编辑文件路径无效。');
        // 只选择此客户端已打开的文档；脱离工作区的草稿仍可查看，提示词按当前目录过滤。
        app.files.focusDocument(session.clientId, params.workspaceId, params.path); return;
      }
      case 'documents.update': {
        app.requireOwner(session.actorId);
        const doc = await app.files.updateDocument(app.workspace(session.actorId, params.workspaceId, ['workspace_write']), params.path, session.clientId, params.text, params.version);
        app.languages.documentChanged(doc); return doc;
      }
      case 'documents.save': {
        app.requireOwner(session.actorId);
        const doc = await app.files.saveDocument(app.workspace(session.actorId, params.workspaceId, ['workspace_write']), params.path, session.clientId, params.version);
        app.languages.documentChanged(doc, true); return doc;
      }
      case 'documents.close': {
        app.requireOwner(session.actorId);
        await app.files.closeDocument({ id: params.workspaceId }, params.path, session.clientId, params.discard === true);
        await app.languages.documentClosed(session, params.workspaceId, params.path); return;
      }
      case "processes.start":
        app.requireOwner(session.actorId);
        return app.processes.start(
          app.workspace(session.actorId, params.workspaceId, [
            "process_execute",
          ]),
          session.clientId,
          params.command,
          params.args,
        );
      case "processes.read":
        app.requireOwner(session.actorId);
        return app.processes.read(params.id, session.clientId);
      case "processes.input":
        app.requireOwner(session.actorId);
        return app.processes.input(params.id, session.clientId, params.text);
      case "processes.stop":
        app.requireOwner(session.actorId);
        return app.processes.stop(params.id, session.clientId);
      case "storage.info":
        app.requireOwner(session.actorId);
        return app.storage.statistics();
      default:
        throw new Error(`Unknown application method: ${method}`);
    }
  }
  async mayReceive(
    session: ClientSession,
    notification: Record<string, any>,
  ): Promise<boolean> {
    if (notification.clientId && notification.clientId !== session.clientId) return false;
    if (Array.isArray(notification.excludeClientIds) && notification.excludeClientIds.includes(session.clientId)) return false;
    const actor = this.application.actor(session.actorId);
    if (!actor) return false;
    if (actor.role === "owner") return true;
    const runId = notification.runId ?? notification.event?.runId;
    return (
      typeof runId === "string" &&
      (await this.application.storage.getRun(runId))?.actorId === actor.id
    );
  }
}
