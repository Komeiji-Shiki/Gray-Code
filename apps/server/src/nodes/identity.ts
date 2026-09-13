import 'reflect-metadata';
import { randomBytes, randomUUID, createHash, webcrypto, X509Certificate as NativeCertificate } from 'node:crypto';
import { hostname } from 'node:os';
import { SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import type { NodeListenerSettings } from '@graycode/contracts';
import type { PlatformStorage } from '@graycode/core';
import type { SecretCodec } from '../settings/service';

export const nodeHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nodeSecret = () => randomBytes(32).toString('base64url');
export const nodeServerName = (id: string) => `graycode-${id}.local`;
export const validNodeId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value);
export function nodeText(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label}无效。`);
  return value.trim();
}
export function nodeAddress(value: unknown): string {
  const url = new URL(nodeText(value, '设备地址', 512));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('执行节点地址必须是 HTTPS 根地址。');
  return url.origin;
}
export function nodeCertificate(pem: unknown, nodeId: string) {
  if (typeof pem !== 'string' || pem.length > 16_384) throw new Error('设备证书无效。');
  const certificate = new NativeCertificate(pem);
  if (!validNodeId(nodeId) || !certificate.checkHost(nodeServerName(nodeId), { wildcards: false }) || !certificate.verify(certificate.publicKey)) throw new Error('设备证书与身份不匹配。');
  return { pem: certificate.toString(), fingerprint: certificate.fingerprint256 };
}
interface LocalNode { id: string; settings: NodeListenerSettings; certificate?: string; privateKeyRef?: string }
export interface NodeInvitation { version: 1; nodeId: string; name: string; address: string; certificate: string; secret: string; expiresAt: number }
export function parseInvitation(code: unknown): NodeInvitation {
  const value = nodeText(code, '配对码', 24_000);
  if (!value.startsWith('graycode-node.v1.')) throw new Error('请输入执行设备生成的完整配对码。');
  const data = JSON.parse(Buffer.from(value.slice(17), 'base64url').toString('utf8')) as NodeInvitation;
  if (data.version !== 1 || !validNodeId(data.nodeId) || !/^[\w-]{43}$/.test(data.secret) || !Number.isFinite(data.expiresAt)) throw new Error('配对码格式无效。');
  return { ...data, name: nodeText(data.name, '设备名称'), address: nodeAddress(data.address), certificate: nodeCertificate(data.certificate, data.nodeId).pem };
}

/** 公钥证书可以分享；私钥和连接凭据只通过现有的宿主加密端口保存。 */
export class NodeIdentity {
  private value!: LocalNode;
  private generating?: Promise<{ certificate: string; privateKey: string }>;
  constructor(private readonly storage: PlatformStorage, private readonly codec?: SecretCodec) {}
  get id() { return this.value.id; }
  get settings() { return structuredClone(this.value.settings); }
  get secureStorage() { return !!this.codec; }
  async initialize() {
    const saved = await this.storage.getRecord('execution-node', 'local') as LocalNode | null;
    this.value = saved ?? { id: randomUUID(), settings: { enabled: false, name: hostname(), host: '127.0.0.1', port: 0 } };
    if (!saved) await this.save();
  }
  private save() { return this.storage.putRecord({ namespace: 'execution-node', id: 'local', value: this.value }); }
  async configure(settings: NodeListenerSettings) { this.value.settings = structuredClone(settings); await this.save(); }
  async seal(value: string) {
    if (!this.codec) throw new Error('执行节点需要可用的加密存储。桌面端使用系统保护，命令行请配置 --key-env。');
    return this.codec.encrypt(value);
  }
  async open(value: Uint8Array) {
    if (!this.codec) throw new Error('当前启动方式无法解密设备凭据，请恢复原加密存储配置。');
    return this.codec.decrypt(value);
  }
  async credential(reference: string) {
    const value = await this.storage.getRecord('platform-secrets', reference) as { encrypted: Uint8Array } | null;
    if (!value) throw new Error('设备加密凭据不可用，请恢复原凭据或重新配对。');
    return this.open(value.encrypted);
  }
  credentials() {
    return this.generating ??= this.loadCredentials().catch(error => { this.generating = undefined; throw error; });
  }
  private async loadCredentials() {
    if (this.value.certificate && this.value.privateKeyRef) return { certificate: this.value.certificate, privateKey: await this.credential(this.value.privateKeyRef) };
    // 证书只固定本节点身份；连接地址变化不会改变信任关系，也不写入系统证书库。
    if (!this.codec) await this.seal('');
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const now = Date.now();
    const certificate = await X509CertificateGenerator.createSelfSigned({ serialNumber: randomBytes(16).toString('hex'),
      name: `CN=${nodeServerName(this.id)}`, notBefore: new Date(now - 300_000), notAfter: new Date(now + 5 * 365 * 86_400_000),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, keys,
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: nodeServerName(this.id) }])],
    }, webcrypto as unknown as NonNullable<Parameters<typeof X509CertificateGenerator.createSelfSigned>[1]>);
    const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const encrypted = await this.seal(privateKey);
    this.value.certificate = certificate.toString('pem'); this.value.privateKeyRef = `node_identity_${this.id.replaceAll('-', '')}`;
    await this.storage.commitRecords([{ namespace: 'platform-secrets', id: this.value.privateKeyRef, value: { encrypted } },
      { namespace: 'execution-node', id: 'local', value: this.value }]);
    return { certificate: this.value.certificate, privateKey };
  }
}
