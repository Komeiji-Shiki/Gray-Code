import type { BrowserProfile } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { BrowserProfiles } from '../../../apps/desktop/src/browser/profiles';

function fixture() {
  const records = new Map<string, BrowserProfile>([
    ['owner-work', { id: 'owner-work', actorId: 'owner', name: 'Work' }],
    ['guest-work', { id: 'guest-work', actorId: 'guest', name: 'Guest work' }],
    ['default:guest', { id: 'default:guest', actorId: 'guest', name: 'Guest default' }],
  ]);
  const storage = {
    listRecords: jest.fn(async () => [...records.keys()]),
    readRecordPage: jest.fn(async (namespace: string, _ownerId: string | undefined, options: { afterId?: string; limit: number }) =>
      [...records.keys()].sort().filter(id => options.afterId === undefined || id > options.afterId).slice(0, options.limit)
        .map(id => ({ namespace, id, value: records.get(id) }))),
    getRecord: jest.fn(async (_namespace: string, id: string) => records.get(id) ?? null),
    getVersionedRecord: jest.fn(async () => ({ revision: null })), commitRecords: jest.fn(async () => {}),
  };
  return { profiles: new BrowserProfiles({ storage } as unknown as PlatformApplication), storage };
}

test.each([undefined, '', ' ', '\t\r\n', '　'])('省略或空白 profileId %j 使用当前账号默认配置且保留默认分区', async id => {
  const { profiles } = fixture();
  const owner = await profiles.get('owner', id);
  expect(owner).toMatchObject({ id: 'default:owner', actorId: 'owner' });
  expect(profiles.partition(owner)).toBe('persist:graycode-browser');
  const guest = await profiles.get('guest', id);
  expect(guest).toMatchObject({ id: 'default:guest', actorId: 'guest' });
  expect(profiles.partition(guest)).not.toBe(profiles.partition(owner));
});

test.each(['default:owner', 'owner-work'])('显式账号内配置 %s 仍精确解析', async id => {
  const { profiles, storage } = fixture();
  expect(await profiles.get('owner', id)).toMatchObject({ id, actorId: 'owner' });
  expect(storage.getRecord).toHaveBeenCalledTimes(1);
  expect(storage.listRecords).not.toHaveBeenCalled();
});

test.each(['missing', 'default:guest', 'guest-work', ' default:owner ', ' owner-work '])('显式未知或其他账号配置 %j 不回退到默认配置', async id => {
  const { profiles } = fixture();
  await expect(profiles.get('owner', id)).rejects.toThrow('登录配置不存在或不属于当前账号');
});

test('其他账号也不能使用主人默认或自定义配置', async () => {
  const { profiles } = fixture();
  await expect(profiles.get('guest', 'default:owner')).rejects.toThrow('登录配置不存在或不属于当前账号');
  await expect(profiles.get('guest', 'owner-work')).rejects.toThrow('登录配置不存在或不属于当前账号');
  expect((await profiles.list('owner')).every(profile => profile.actorId === 'owner')).toBe(true);
});

test('空白 ID 解析为默认配置后重命名使用规范记录 ID', async () => {
  const { profiles, storage } = fixture();
  await profiles.rename('owner', '  ', '默认工作配置');
  expect(storage.getVersionedRecord).toHaveBeenCalledWith('browser-profiles', 'default:owner');
  expect(storage.commitRecords).toHaveBeenCalledWith([{ namespace: 'browser-profiles', id: 'default:owner', expectedRevision: null,
    value: { id: 'default:owner', actorId: 'owner', name: '默认工作配置' } }]);
});
