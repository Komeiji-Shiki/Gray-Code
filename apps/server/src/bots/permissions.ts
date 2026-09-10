import type { ActorIdentity, AppSettings, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

interface BotUserIdentity { platform: 'discord' | 'onebot'; platformUserId: string; network?: string }
const botGuestActorPrefix = 'bot-guest:';
const userBinding = (settings: AppSettings, source: BotUserIdentity) => settings.bindings.find(binding => binding.platform === source.platform
  && binding.platformUserId === source.platformUserId && (source.platform !== 'onebot' || (binding.network ?? 'qq') === (source.network ?? 'qq')));
const guestActorId = (source: BotUserIdentity) => botGuestActorPrefix + Buffer.from(JSON.stringify([
  source.platform, source.platform === 'onebot' ? source.network ?? 'qq' : '', source.platformUserId,
])).toString('base64url');

export function isBotUserBlocked(settings: AppSettings, source: BotUserIdentity): boolean {
  const binding = userBinding(settings, source);
  return binding?.blocked === true || !!binding?.accountId && !settings.accounts.some(account => account.id === binding.accountId && !account.revoked);
}

/** 身份来自真实平台事件；拉黑和失效绑定不回退到默认访客权限。 */
export function resolveBotUser(settings: AppSettings, source: BotUserIdentity): ActorIdentity | null {
  if (isBotUserBlocked(settings, source)) return null;
  const binding = userBinding(settings, source);
  if (binding?.accountId) return structuredClone(settings.accounts.find(account => account.id === binding.accountId) ?? null);
  const account = settings.accounts.find(item => item.id === settings.botGuestAccountId && !item.revoked && item.role !== 'owner');
  if (!account) return null;
  return { ...structuredClone(account), id: guestActorId(source), permissionAccountId: account.id };
}

/** 访客 ID 可以重建真实平台身份，重启后仍重新读取当前权限，不缓存授权副本。 */
export function resolveBotGuestActor(settings: AppSettings, id: string): ActorIdentity | null {
  if (!id.startsWith(botGuestActorPrefix) || id.length > 512) return null;
  try {
    const value = JSON.parse(Buffer.from(id.slice(botGuestActorPrefix.length), 'base64url').toString());
    if (!Array.isArray(value) || value.length !== 3 || !['discord', 'onebot'].includes(value[0]) || typeof value[1] !== 'string'
      || typeof value[2] !== 'string' || !value[2].trim()) return null;
    const source: BotUserIdentity = { platform: value[0], network: value[1], platformUserId: value[2] };
    if (guestActorId(source) !== id) return null;
    const actor = resolveBotUser(settings, source);
    return actor?.id === id ? actor : null;
  } catch { return null; }
}

/** 每次模型与工具执行都重新检查 Bot 发言人的准入，包含其派发的子任务。 */
export async function actorForBotRun(app: PlatformApplication, actorId: string, scope?: RunRecord | Pick<RunRecord, 'conversationId' | 'workspaceId'>): Promise<ActorIdentity | null> {
  const actor = app.actor(actorId);
  if (!actor || !scope) return actor;
  if ('id' in scope) {
    for (const platform of ['discord', 'onebot'] as const) {
      const sessions = app[platform].sessions;
      const route = await sessions.routeForRun(platform, scope);
      if (route) {
        if (route.actorId !== actorId || !await sessions.admitted(route)) return null;
        break;
      }
    }
  }
  if (actor.botWorkspaceAccess !== false && actor.workspaceIds !== '*') {
    const conversation = await app.storage.getConversation(scope.conversationId);
    const platform = (conversation?.custom as { botOrigin?: { platform?: string } } | undefined)?.botOrigin?.platform;
    const workspaceId = scope.workspaceId ?? conversation?.workspaceId;
    // 仅按当前 Bot 对话的受控标识匹配，不按路径前缀开放其他频道或普通项目。
    if (['discord', 'onebot'].includes(platform ?? '') && workspaceId === `workspace-${scope.conversationId}`
      && app.settings.snapshot().settings.workspaces.some(workspace => workspace.id === workspaceId))
      return { ...actor, workspaceIds: [...new Set([...actor.workspaceIds, workspaceId])] };
  }
  return actor;
}

export function removePermissionAccount(settings: AppSettings, accountId: string): void {
  settings.accounts = settings.accounts.filter(account => account.id !== accountId);
  // 删除授权账号后仍拒绝原绑定用户，避免通过默认访客配置重新获得权限。
  settings.bindings = settings.bindings.map(binding => binding.accountId === accountId ? { ...binding, accountId: '', blocked: true } : binding);
  if (settings.botGuestAccountId === accountId) delete settings.botGuestAccountId;
}
