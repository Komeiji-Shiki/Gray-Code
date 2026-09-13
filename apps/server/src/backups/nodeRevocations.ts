import { PlatformStorage } from '@graycode/core';
import type { RecordMutation } from '@graycode/contracts';
import type { NodePeer } from '../nodes/registry';

/** 撤销发生在备份之后时，恢复不能让旧凭据再次获得执行权限。 */
export async function preserveNodeRevocations(currentDirectory: string, restoredDirectory: string) {
  const current = await PlatformStorage.open(currentDirectory);
  try {
    const ids = await current.listRecords('node-revocations'); if (!ids.length) return;
    const restored = await PlatformStorage.open(restoredDirectory);
    try {
      for (const id of ids) {
        const tombstone = await current.getRecord('node-revocations', id) as { revokedAt: number };
        const peer = await restored.getRecord('node-peers', id) as NodePeer | null;
        const mutations: RecordMutation[] = [{ namespace: 'node-revocations', id, value: tombstone }];
        if (peer) mutations.push({ namespace: 'node-peers', id, value: { ...peer, revokedAt: tombstone.revokedAt, tokenHash: undefined } },
          { namespace: 'platform-secrets', id: peer.credentialRef, delete: true });
        await restored.commitRecords(mutations);
      }
      await restored.checkpoint();
    } finally { await restored.close(); }
  } finally { await current.close(); }
}
