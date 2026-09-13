import { createHash } from 'node:crypto';
import type { BackupManifest, PetResource } from '@graycode/contracts';
import type { PlatformStorage } from '@graycode/core';
import { petAssetPath } from '../../../../shared/petFormat';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const resourceVersions = new Set(['conversations', 'settings', 'memories', 'devices', 'pets', 'screen', 'skills', 'other']);

/** 清单版本之外，再核对桌宠文件之间的引用；附件块校验不能代替资源完整性校验。 */
export async function validateBackupResources(storage: PlatformStorage, manifest?: BackupManifest) {
  if (manifest?.version === 2 && (!Array.isArray(manifest.resources) || manifest.resources.some(resource => !resourceVersions.has(resource.id) || resource.version !== 1 || !Number.isSafeInteger(resource.count) || resource.count < 0)))
    throw new Error('备份包含尚不支持的资源版本，请使用对应版本的 GrayCode 恢复。');
  const ids = await storage.listRecords('pet-resource');
  for (const id of ids) {
    const resource = await storage.getRecord('pet-resource', id) as PetResource;
    if (resource.id !== id || !['sprite', 'live2d'].includes(resource.kind) || !Array.isArray(resource.files) || !resource.files.length
      || !resource.files.some(file => file.path === resource.entry) || new Set(resource.files.map(file => file.path)).size !== resource.files.length)
      throw new Error(`桌宠资源清单无效：${resource.name || id}`);
    if (resource.kind === 'sprite' && (!resource.sprite || ![1, 2].includes(resource.sprite.version))) throw new Error('桌宠图集版本不受支持。');
    for (const file of resource.files) {
      if (petAssetPath(file.path) !== file.path) throw new Error('桌宠资源文件路径无效。');
      const saved = await storage.getRecord('pet-resource-file', `${id}/${file.path}`) as { bytes?: Uint8Array } | null;
      if (!(saved?.bytes instanceof Uint8Array) || saved.bytes.length !== file.bytes || hash(saved.bytes) !== file.sha256) throw new Error(`桌宠资源文件缺失或已损坏：${resource.name} / ${file.path}`);
    }
    const files = resource.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, mimeType: file.mimeType }));
    if (hash(JSON.stringify(files)) !== resource.sha256) throw new Error(`桌宠资源清单校验失败：${resource.name}`);
  }
  const runtime = await storage.getRecord('pet-runtime', 'info') as { sha256: string; bytes: number } | null;
  const core = await storage.getRecord('pet-runtime', 'core') as { bytes?: Uint8Array } | null;
  if (!!runtime !== !!core || runtime && (!(core?.bytes instanceof Uint8Array) || runtime.bytes !== core.bytes.length || runtime.sha256 !== hash(core.bytes))) throw new Error('本地 Live2D Core 缺失或已损坏。');
}

/** 从备份恢复的连接和未完成任务等待重新启用，避免重复发送旧请求。 */
export async function pauseRestoredActivities(storage: PlatformStorage) {
  for (const id of await storage.listRecords('automations')) {
    const record = await storage.getRecord('automations', id) as Record<string, any>;
    if (record.status === 'completed') continue;
    const value: Record<string, any> = { ...record, status: 'paused', pauseReason: 'restart', error: '从备份恢复后已暂停，请检查原任务结果和配置，再继续。', nextRunAt: undefined, pendingEvent: undefined };
    if (record.pendingEvent) value.recentEvents = [...(record.recentEvents ?? []).filter((event: any) => event.key !== record.pendingEvent.key), { ...record.pendingEvent, status: 'cancelled', reason: '从备份恢复后取消待执行事件。' }].slice(-30);
    await storage.putRecord({ namespace: 'automations', id, ownerId: record.conversationId, value });
  }
  const settings = await storage.getRecord('platform-settings', 'main') as Record<string, any> | null;
  if (settings) await storage.putRecord({ namespace: 'platform-settings', id: 'main', value: { ...settings,
    ...(settings.discord ? { discord: { ...settings.discord, autoConnect: false } } : {}),
    ...(settings.onebot ? { onebot: { ...settings.onebot, autoConnect: false } } : {}),
    ...(settings.remoteAccess ? { remoteAccess: { ...settings.remoteAccess, enabled: false } } : {}),
  } });
  const node = await storage.getRecord('execution-node', 'local') as Record<string, any> | null;
  if (node) await storage.putRecord({ namespace: 'execution-node', id: 'local', value: { ...node, settings: { ...node.settings, enabled: false } } });
  for (const id of await storage.listRecords('node-peers')) {
    const peer = await storage.getRecord('node-peers', id) as Record<string, any>;
    if (peer.direction === 'outgoing') await storage.putRecord({ namespace: 'node-peers', id, value: { ...peer, paused: true } });
  }
  for (const namespace of ['node-invitations', 'node-pairing-pending', 'web-sessions']) for (const id of await storage.listRecords(namespace)) await storage.deleteRecord(namespace, id);
  const actors = new Set((await storage.backupInventory()).filter(unit => unit.kind === 'long-memory').map(unit => unit.actorId!));
  for (const actor of actors) for (const scope of await storage.longMemoryScopes(actor))
    for (const job of await storage.longMemoryJobs({ scopes: [scope] })) if (['pending', 'running'].includes(job.status)) await storage.longMemoryJobTransition({ scope, id: job.id, action: 'cancel' });
}
