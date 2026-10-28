import { createHash } from 'node:crypto';
import type { ActorIdentity, LongMemoryScope, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../application';
import { MEMORY_IMPORT_POLICY_NAMESPACE, type MemoryImportPolicy } from '@graycode/contracts';
import { authorizeEffects } from '@graycode/core';

export function longMemoryScope(actorId:string,kind:LongMemoryScope['kind'],realm='real',key?:string):LongMemoryScope {
  const id=createHash('sha256').update(JSON.stringify([actorId,kind,key??null,realm])).digest('hex');
  return {id,actorId,kind,realm,...key?{key}:{}};
}

/** 模型只能主动检索已启用的导入资料库，旧记忆范围继续由管理界面访问。 */
export async function conversationMemoryScopes(app:PlatformApplication,actor:ActorIdentity,workspace?:WorkspaceDefinition):Promise<LongMemoryScope[]> {
  if(actor.revoked||actor.role==='guest'||actor.role!=='owner'&&!actor.effects.includes('workspace_read'))return [];
  // 账号已包含当前频道的受控授权，重新按普通账号读取会丢失合法的子任务继承。
  if(workspace){const denied=authorizeEffects(actor,['workspace_read'],workspace);if(denied)throw new Error(denied);}
  const imports = await app.storage.getRecord(MEMORY_IMPORT_POLICY_NAMESPACE, actor.id) as MemoryImportPolicy | null;
  return imports ? imports.enabledScopes.filter(scope =>
    scope.actorId === actor.id && scope.realm === 'real' && scope.kind === 'library' && scope.key) : [];
}
