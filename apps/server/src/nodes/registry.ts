import { randomUUID } from 'node:crypto';
import type { NodeGrant } from '@graycode/contracts';
import type { PlatformStorage } from '@graycode/core';
import { NodeIdentity, nodeHash, nodeSecret, nodeText, validNodeId, type NodeInvitation } from './identity';

export interface NodePeer {
  id: string; nodeId: string; name: string; direction: 'incoming' | 'outgoing'; createdAt: number;
  revokedAt?: number; tokenHash?: string; credentialRef: string; grant: NodeGrant;
  address?: string; certificate?: string;
  paused?: boolean;
}
interface InvitationRecord { hash: string; expiresAt: number; grant: NodeGrant; peerId?: string; requestKey?: string }
export class NodeRegistry {
  readonly peers = new Map<string, NodePeer>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: PlatformStorage, readonly identity: NodeIdentity) {}
  async initialize() {
    const records = await this.storage.listRecords('node-peers');
    for (const id of records) {
      const peer = await this.storage.getRecord('node-peers', id) as NodePeer;
      const revoked = await this.storage.getRecord('node-revocations', peer.id) as { revokedAt: number } | null;
      if (revoked) peer.revokedAt = revoked.revokedAt;
      this.peers.set(peer.id, peer);
    }
  }
  private serialized<T>(action: () => Promise<T>) {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  async invitation(grant: NodeGrant) {
    const secret = nodeSecret(), hash = nodeHash(secret), expiresAt = Date.now() + 10 * 60_000;
    await this.storage.putRecord({ namespace: 'node-invitations', id: hash, value: { hash, expiresAt, grant } satisfies InvitationRecord });
    // 过期邀请只用于配对重试，不保留无限增长的失效入口。
    for (const id of await this.storage.listRecords('node-invitations')) {
      const record = await this.storage.getRecord('node-invitations', id) as InvitationRecord;
      if (record.expiresAt < Date.now()) await this.storage.deleteRecord('node-invitations', id);
    }
    return { secret, expiresAt };
  }
  accept(input: Record<string, any>, validate: (grant: NodeGrant) => void) {
    return this.serialized(async () => {
      if (!validNodeId(input.nodeId) || input.nodeId === this.identity.id || !/^[\w-]{43}$/.test(input.secret)) throw new Error('配对设备身份或配对码无效。');
      const requestKey = nodeText(input.requestKey, '配对请求标识');
      const hash = nodeHash(input.secret), saved = await this.storage.getVersionedRecord('node-invitations', hash);
      const invite = saved.value as InvitationRecord | null;
      if (!invite || invite.expiresAt < Date.now()) throw new Error('配对码已经失效，请在执行设备上重新生成。');
      validate(invite.grant);
      if (invite.peerId) {
        const peer = this.peers.get(invite.peerId);
        if (!peer || peer.revokedAt || peer.nodeId !== input.nodeId || invite.requestKey !== requestKey) throw new Error('配对码已被使用。');
        return { peer, token: await this.identity.credential(peer.credentialRef) };
      }
      if ([...this.peers.values()].some(peer => peer.direction === 'incoming' && !peer.revokedAt && peer.nodeId === input.nodeId)) throw new Error('此设备已经配对，请恢复已有连接，或先撤销旧配对。');
      const token = nodeSecret(), peerId = randomUUID(), credentialRef = `node_peer_${peerId.replaceAll('-', '')}`;
      const peer: NodePeer = { id: peerId, nodeId: input.nodeId, name: nodeText(input.name, '连接设备名称'), direction: 'incoming',
        createdAt: Date.now(), grant: structuredClone(invite.grant), credentialRef, tokenHash: nodeHash(token) };
      await this.storage.commitRecords([
        { namespace: 'node-peers', id: peer.id, value: peer, expectedRevision: null },
        { namespace: 'platform-secrets', id: credentialRef, value: { encrypted: await this.identity.seal(token) }, expectedRevision: null },
        { namespace: 'node-invitations', id: hash, value: { ...invite, peerId: peer.id, requestKey }, expectedRevision: saved.revision },
      ]);
      this.peers.set(peer.id, peer); return { peer, token };
    });
  }
  async pairingRequest(invitation: NodeInvitation) {
    const id = nodeHash(invitation.secret), saved = await this.storage.getRecord('node-pairing-pending', id) as { requestKey: string } | null;
    if (saved) return saved.requestKey;
    const requestKey = randomUUID();
    await this.storage.putRecord({ namespace: 'node-pairing-pending', id, value: { requestKey, createdAt: Date.now() } }); return requestKey;
  }
  async connectedPair(invitation: NodeInvitation, response: { peerId: string; token: string; nodeId: string; grant: NodeGrant }) {
    if (!validNodeId(response.peerId) || response.nodeId !== invitation.nodeId || !/^[\w-]{43}$/.test(response.token)) throw new Error('执行设备返回了无效配对结果。');
    const peer: NodePeer = { id: response.peerId, nodeId: invitation.nodeId, name: invitation.name, direction: 'outgoing', createdAt: Date.now(),
      address: invitation.address, certificate: invitation.certificate, grant: response.grant, credentialRef: `node_peer_${response.peerId.replaceAll('-', '')}` };
    const previous = this.peers.get(peer.id); if (previous?.revokedAt) throw new Error('此配对已在本机撤销，请生成新的配对码。');
    if (previous) peer.createdAt = previous.createdAt;
    await this.storage.commitRecords([{ namespace: 'node-peers', id: peer.id, value: peer },
      { namespace: 'platform-secrets', id: peer.credentialRef, value: { encrypted: await this.identity.seal(response.token) } }]);
    this.peers.set(peer.id, peer); return peer;
  }
  async save(peer: NodePeer) { await this.storage.putRecord({ namespace: 'node-peers', id: peer.id, value: peer }); this.peers.set(peer.id, peer); }
  async revoke(peer: NodePeer) {
    const value = { ...peer, revokedAt: Date.now(), tokenHash: undefined };
    await this.storage.commitRecords([{ namespace: 'node-peers', id: peer.id, value },
      { namespace: 'platform-secrets', id: peer.credentialRef, delete: true },
      { namespace: 'node-revocations', id: peer.id, value: { revokedAt: value.revokedAt, nodeId: peer.nodeId, direction: peer.direction } }]);
    this.peers.set(peer.id, value);
  }
}
