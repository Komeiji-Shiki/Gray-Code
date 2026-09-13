import { createHash } from 'node:crypto';
import type { ActorIdentity, LongMemoryScope, PlatformConversation, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../application';
import { BOT_CHANNEL_ACCESS, type BotChannelAccess } from '../../bots/channelAccess';
import { workspaceDirectoryKey } from '../../workspace/identity';

export function longMemoryScope(actorId:string,kind:LongMemoryScope['kind'],realm='real',key?:string):LongMemoryScope {
  const id=createHash('sha256').update(JSON.stringify([actorId,kind,key??null,realm])).digest('hex');
  return {id,actorId,kind,realm,...key?{key}:{}};
}

/** 群聊只读取经真实 Bot 入口绑定的共享范围，不把发言人的私人记忆公开到群里。 */
export async function conversationMemoryScopes(app:PlatformApplication,actor:ActorIdentity,conversation?:PlatformConversation,workspace?:WorkspaceDefinition,draft=false):Promise<LongMemoryScope[]> {
  if(actor.revoked||actor.role==='guest'||actor.role!=='owner'&&!actor.effects.includes('workspace_read'))return [];
  const custom=conversation?.custom as Record<string,unknown>|undefined;
  const realm=custom?.platformMode==='character'?`character:${conversation!.id}`:'real';
  if(conversation&&!draft){
    await app.conversation(actor.id,conversation.id);
    const access=await app.storage.getRecord(BOT_CHANNEL_ACCESS,conversation.id) as BotChannelAccess|null;
    if(access?.version===1&&!access.context.direct){
      const channel=access.context;
      if(typeof conversation.actorId!=='string')throw new Error('共享记忆缺少已绑定的账号。');
      return [longMemoryScope(conversation.actorId,'group',realm,JSON.stringify([channel.platform,channel.network??'',channel.botId,channel.channelId]))];
    }
  }
  const scopes=[longMemoryScope(actor.id,'personal',realm)];
  if(workspace){
    app.workspace(actor.id,workspace.id,['workspace_read']);
    scopes.push(longMemoryScope(actor.id,'workspace',realm,workspaceDirectoryKey(workspace.directory)));
  }
  return scopes;
}
