import { createHash } from 'node:crypto';
import type { ActorIdentity, LongMemoryScope, PlatformConversation, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../application';
import { BOT_CHANNEL_ACCESS, type BotChannelAccess } from '../../bots/channelAccess';
import { workspaceDirectoryKey } from '../../workspace/identity';
import { MEMORY_IMPORT_POLICY_NAMESPACE, type MemoryImportPolicy } from '@graycode/contracts';
import { authorizeEffects } from '@graycode/core';

export function longMemoryScope(actorId:string,kind:LongMemoryScope['kind'],realm='real',key?:string):LongMemoryScope {
  const id=createHash('sha256').update(JSON.stringify([actorId,kind,key??null,realm])).digest('hex');
  return {id,actorId,kind,realm,...key?{key}:{}};
}

/** 群聊只读取经真实 Bot 入口绑定的共享范围，不把发言人的私人记忆公开到群里。 */
export async function conversationMemoryScopes(app:PlatformApplication,actor:ActorIdentity,conversation?:PlatformConversation,workspace?:WorkspaceDefinition,draft=false):Promise<LongMemoryScope[]> {
  if(actor.revoked||actor.role==='guest'||actor.role!=='owner'&&!actor.effects.includes('workspace_read'))return [];
  // 账号已包含当前频道的受控授权，重新按普通账号读取会丢失合法的子任务继承。
  if(workspace){const denied=authorizeEffects(actor,['workspace_read'],workspace);if(denied)throw new Error(denied);}
  if(conversation&&!draft){
    await app.conversation(actor.id,conversation.id);
    const rootId=app.subagents.rootConversationId(conversation.id);
    // 父子关系来自宿主派发记录；群聊的子任务必须沿用根群聊范围，不能回退私人记忆。
    if(rootId!==conversation.id)conversation=await app.conversation(actor.id,rootId);
  }
  const custom=conversation?.custom as Record<string,unknown>|undefined;
  const realm=custom?.platformMode==='character'?`character:${conversation!.id}`:'real';
  if(conversation&&!draft){
    const access=await app.storage.getRecord(BOT_CHANNEL_ACCESS,conversation.id) as BotChannelAccess|null;
    if(access?.version===1&&!access.context.direct){
      const channel=access.context;
      if(typeof conversation.actorId!=='string')throw new Error('共享记忆缺少已绑定的账号。');
      return [longMemoryScope(conversation.actorId,'group',realm,JSON.stringify([channel.platform,channel.network??'',channel.botId,channel.channelId]))];
    }
  }
  const scopes=[longMemoryScope(actor.id,'personal',realm)];
  if(workspace){
    scopes.push(longMemoryScope(actor.id,'workspace',realm,workspaceDirectoryKey(workspace.directory)));
  }
  if (realm === 'real') {
    const imports = await app.storage.getRecord(MEMORY_IMPORT_POLICY_NAMESPACE, actor.id) as MemoryImportPolicy | null;
    for (const scope of imports?.enabledScopes ?? []) if (scope.actorId === actor.id && scope.realm === 'real' && scope.kind === 'library' && scope.key) scopes.push(scope);
  }
  return scopes;
}
