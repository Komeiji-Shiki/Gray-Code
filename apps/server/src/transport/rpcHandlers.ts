import type { CompanionRpcMethods, ModelRequestSnapshot, PetRpcMethods, RpcMethod, RpcParams, RpcResult, ScreenSenseRpcMethods } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';
import { createPetChat, petInbox, sendPetChat } from '../pets/interactions';
import { restoreCharacterTurn } from '../characters/snapshot';

type HostedMethod = 'diagnostics.get' | 'settings.get' | 'settings.save' | 'files.list' | 'files.inspect' | 'files.downloadInfo'
  | 'files.create' | 'files.move' | 'files.remove' | 'files.upload' | 'runs.list' | 'runs.events' | 'runs.request' | 'runs.cancel' | 'approvals.resolve'
  | keyof ScreenSenseRpcMethods | keyof CompanionRpcMethods | keyof PetRpcMethods
  | 'pets.chat.create' | 'pets.chat.send' | 'pets.inbox';
type Handler<M extends RpcMethod> = (app: PlatformApplication, session: ClientSession, params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;

/** 已迁移的处理器同时检查入参和返回值，服务继续执行原有账号、目录和版本判断。 */
const handlers: { [M in HostedMethod]: Handler<M> } = {
  'screenSense.status': (app, session, params) => app.screenSense.call(session, 'screenSense.status', params),
  'screenSense.get': (app, session, params) => app.screenSense.call(session, 'screenSense.get', params),
  'screenSense.options': (app, session, params) => app.screenSense.call(session, 'screenSense.options', params),
  'screenSense.configure': (app, session, params) => app.screenSense.call(session, 'screenSense.configure', params),
  'screenSense.defaults.save': (app, session, params) => app.screenSense.call(session, 'screenSense.defaults.save', params),
  'screenSense.conversationOpened': (app, session, params) => app.screenSense.call(session, 'screenSense.conversationOpened', params),
  'screenSense.start': (app, session, params) => app.screenSense.call(session, 'screenSense.start', params),
  'screenSense.stop': (app, session, params) => app.screenSense.call(session, 'screenSense.stop', params),
  'screenSense.capture': (app, session, params) => app.screenSense.call(session, 'screenSense.capture', params),
  'screenSense.send': (app, session, params) => app.screenSense.call(session, 'screenSense.send', params),
  'screenSense.cancelRun': (app, session, params) => app.screenSense.call(session, 'screenSense.cancelRun', params),
  'companion.get': (app, session, params) => app.companion.get(session, params),
  'companion.save': (app, session, params) => app.companion.save(session, params),
  'companion.defaults.clear': (app, session, params) => app.companion.clearDefaults(session, params),
  'pets.position': (app, session, params) => app.pets.call(session, 'pets.position', params),
  'pets.list': (app, session, params) => app.pets.call(session, 'pets.list', params),
  'pets.status': (app, session, params) => app.pets.call(session, 'pets.status', params),
  'pets.import': (app, session, params) => app.pets.call(session, 'pets.import', params),
  'pets.bundle': (app, session, params) => app.pets.call(session, 'pets.bundle', params),
  'pets.resource.annotate': (app, session, params) => app.pets.call(session, 'pets.resource.annotate', params),
  'pets.remove': (app, session, params) => app.pets.call(session, 'pets.remove', params),
  'pets.configure': (app, session, params) => app.pets.call(session, 'pets.configure', params),
  'pets.runtime.import': (app, session, params) => app.pets.call(session, 'pets.runtime.import', params),
  'pets.runtime.get': (app, session, params) => app.pets.call(session, 'pets.runtime.get', params),
  'pets.runtime.remove': (app, session, params) => app.pets.call(session, 'pets.runtime.remove', params),
  'pets.renderer.claim': (app, session, params) => app.pets.call(session, 'pets.renderer.claim', params),
  'pets.renderer.ready': (app, session, params) => app.pets.call(session, 'pets.renderer.ready', params),
  'pets.renderer.heartbeat': (app, session, params) => app.pets.call(session, 'pets.renderer.heartbeat', params),
  'pets.renderer.closed': (app, session, params) => app.pets.call(session, 'pets.renderer.closed', params),
  'pets.renderer.failed': (app, session, params) => app.pets.call(session, 'pets.renderer.failed', params),
  'pets.renderer.applied': (app, session, params) => app.pets.call(session, 'pets.renderer.applied', params),
  'pets.command': (app, session, params) => app.pets.call(session, 'pets.command', params),
  'pets.chat.create': (app, session) => createPetChat(app, session),
  'pets.chat.send': (app, session, params) => sendPetChat(app, session, params),
  'pets.inbox': (app, session, params) => petInbox(app, session, params),
  'diagnostics.get': (app, session) => {
    app.requireOwner(session.actorId);
    return { activeRuns: app.runtime.activeCount, ...app.tools.diagnostics(), managedProcesses: app.processes.activeCount,
      eventStream: app.remoteAccess?.status().eventStream };
  },
  'settings.get': (app, session) => {
    app.requireOwner(session.actorId);
    // 外壳启动快照不含 UI 设置，单独带出开屏开关供其决定是否播放动画。
    const splashEnabled = app.product.runtimeSettings().getSettings().ui?.appearance?.splashEnabled !== false;
    return { ...app.settings.snapshot(), splashEnabled };
  },
  'settings.save': (app, session, params) => { app.requireOwner(session.actorId); return app.settings.save(params); },
  'files.list': (app, session, params) => {
    app.requireOwner(session.actorId);
    return app.files.list(app.workspace(session.actorId, params.workspaceId, ['workspace_read']), params.path);
  },
  'files.inspect': (app, session, params) => app.fileActions.inspect(session.actorId, params.workspaceId, params.path),
  'files.downloadInfo': async (app, session, params) => {
    const { absolute: _absolute, ...info } = await app.fileActions.download(session.actorId, params.workspaceId, params.path); return info;
  },
  'files.create': (app, session, params) => app.fileActions.create(session.actorId, params.workspaceId, params.path, params.kind),
  'files.move': (app, session, params) => app.fileActions.move(session.actorId, params.workspaceId, params.path, params.target, params.expectedVersion),
  'files.remove': (app, session, params) => app.fileActions.remove(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.recursive === true),
  'files.upload': (app, session, params) => app.fileActions.upload(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.bytes),
  'runs.list': (app, session, params) => app.storage.listRuns({ conversationId: params.conversationId,
    actorId: app.actor(session.actorId)?.role === 'owner' ? undefined : session.actorId, activeOnly: params.activeOnly, limit: 100 }),
  'runs.events': async (app, session, params) => {
    const run = await app.storage.getRun(params.id);
    if (!run) throw new Error('Run not found.');
    await app.conversation(session.actorId, run.conversationId);
    return app.storage.readRunEvents(params.id, params.afterSequence);
  },
  'runs.request': async (app, session, params) => {
    const run = await app.storage.getRun(params.id);
    if (!run) throw new Error('Run not found.');
    await app.conversation(session.actorId, run.conversationId);
    if (!Number.isSafeInteger(params.iteration) || params.iteration < 1) throw new Error('请选择模型调用轮次。');
    const saved = await app.storage.getRecord('model-requests', `${run.id}:${params.iteration}`) as ModelRequestSnapshot | null;
    const turn = restoreCharacterTurn(saved?.turnContext?.characterTurn);
    return saved && turn ? { ...saved, turnContext: { ...saved.turnContext, characterTurn: turn } } : saved;
  },
  'runs.cancel': (app, session, params) => app.runtime.cancel(params.id, session.actorId),
  'approvals.resolve': (app, session, params) => app.runtime.resolveApproval(params.id, session.actorId, params.accepted, params.choiceId),
};

export function hasRpcHandler(method: string): method is HostedMethod { return Object.hasOwn(handlers, method); }
export function rpcRequest<M extends HostedMethod>(app: PlatformApplication, session: ClientSession, method: M, params: unknown) {
  // 路由入口已用同一份 contracts 字段表完成检查。
  return handlers[method](app, session, params as RpcParams<M>);
}
