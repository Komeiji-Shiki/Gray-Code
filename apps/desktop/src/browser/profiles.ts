import { createHash, randomUUID } from 'node:crypto';
import type { BrowserProfile } from '@graycode/contracts';
import type { PlatformApplication } from '../../../server/src/application';
const namespace = 'browser-profiles';

export class BrowserProfiles {
  constructor(private readonly app: PlatformApplication) {}
  async list(actorId: string): Promise<BrowserProfile[]> {
    const values: BrowserProfile[] = [];
    for (const id of await this.app.storage.listRecords(namespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as BrowserProfile | null;
      if (value?.actorId === actorId) values.push(value);
    }
    if (!values.some(value => value.id === `default:${actorId}`)) values.unshift({ id: `default:${actorId}`, actorId, name: '默认登录配置' });
    return values.sort((left, right) => Number(right.id === `default:${actorId}`) - Number(left.id === `default:${actorId}`) || left.name.localeCompare(right.name));
  }
  async get(actorId: string, id?: string): Promise<BrowserProfile> {
    const value = (await this.list(actorId)).find(item => item.id === (id ?? `default:${actorId}`));
    if (!value) throw new Error('登录配置不存在或不属于当前账号。');
    return value;
  }
  async create(actorId: string, name: unknown): Promise<BrowserProfile> {
    const value = { id: randomUUID(), actorId, name: this.name(name) };
    await this.app.storage.commitRecords([{ namespace, id: value.id, expectedRevision: null, value }]); return value;
  }
  async rename(actorId: string, id: string, name: unknown): Promise<void> {
    const value = await this.get(actorId, id);
    const record = await this.app.storage.getVersionedRecord(namespace, id);
    await this.app.storage.commitRecords([{ namespace, id, expectedRevision: record.revision, value: { ...value, name: this.name(name) } }]);
  }
  partition(profile: BrowserProfile): string {
    // 沿用主人的默认分区，保留已经登录的网站。
    return profile.id === 'default:owner' ? 'persist:graycode-browser' : `persist:graycode-browser-${createHash('sha256').update(profile.id).digest('hex').slice(0, 32)}`;
  }
  private name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error('登录配置名称需要 1 至 100 个字符。');
    return value.trim();
  }
}
