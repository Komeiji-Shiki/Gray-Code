import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopPortableProfile, portableProfileDirectory } from '../../../apps/desktop/src/portableProfile';
import { keySecretCodec } from '../../../apps/server/src/settings/environmentSecrets';
import { PlatformSkills } from '../../../apps/server/src/skills/service';
import { fixture, metadata, message } from './fixtures';

test('移动便携目录后携带配置和密钥，两台机器各自保留工作区与聊天，并同步配置删除', async () => {
  const f = await fixture(); await f.store.close();
  const machineA = keySecretCodec(randomBytes(32)), machineB = keySecretCodec(randomBytes(32));
  // 隔离测试只携带测试配置，不扫描运行测试者的个人技能目录。
  const skills = jest.spyOn(PlatformSkills.prototype, 'export').mockResolvedValue([]);
  let directory = path.join(f.root, 'portable', 'portable-data');
  let app: PlatformApplication | undefined;
  try {
    // 旧便携版已有的本机配置直接成为首次便携配置，历史无需迁移。
    app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: machineA });
    const draft = await app.product.draft();
    draft.app.workspaces.push({ id: 'project', name: '本机工程', directory: f.source, deviceId: 'local' });
    draft.app.appearance.fontSize = 18;
    const channel = await draft.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000,
      url: 'https://example.invalid/v1', name: '便携渠道', model: 'fixture', apiKey: 'portable-test-secret' });
    await draft.settings.updateToolConfig('generate_image', { apiKey: 'portable-image-secret' } as any);
    await app.product.save(draft);
    const background = await app.images.add({ name: '便携背景', dataUrl: 'data:image/png;base64,aGVsbG8=', thumbnail: '', width: 1, height: 1 });
    await app.storage.initializeConversation({ ...metadata('chat_a'), workspaceId: 'project' }, [message(1, '只留在机器 A 的聊天')]);
    await app.close(); app = undefined;
    app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: machineA, configurationPersistence: new DesktopPortableProfile(directory) });
    const encrypted = await readFile(path.join(directory, 'settings.enc'));
    expect(encrypted.includes(Buffer.from('portable-test-secret'))).toBe(false);
    const portableCodec = keySecretCodec(await readFile(path.join(directory, 'profile.key')));
    const exported = JSON.parse(await portableCodec.decrypt(encrypted));
    expect(exported.settings).not.toHaveProperty('workspaces');
    expect(exported.settings).not.toHaveProperty('accounts');
    expect(JSON.stringify(exported)).not.toContain('只留在机器 A 的聊天');
    expect(await app.storage.getConversation('chat_a')).not.toBeNull();
    await app.close(); app = undefined;

    const moved = path.join(f.root, '移动后的便携程序');
    expect(path.dirname(path.dirname(directory))).toBe(f.root);
    expect(path.dirname(moved)).toBe(f.root);
    await rename(path.dirname(directory), moved); directory = path.join(moved, 'portable-data');
    app = await PlatformApplication.open({ dataDirectory: path.join(f.root, 'machine-b'), secretCodec: machineB,
      configurationPersistence: new DesktopPortableProfile(directory) });
    expect(app.settings.snapshot().settings.appearance.fontSize).toBe(18);
    expect(app.settings.snapshot().settings.workspaces).toEqual([]);
    expect((await app.storage.listConversations()).items).toEqual([]);
    expect(await app.product.channel(channel)).toMatchObject({ apiKey: 'portable-test-secret' });
    expect(app.product.runtimeSettings().getToolsConfig().generate_image).toMatchObject({ apiKey: 'portable-image-secret' });
    expect((await app.images.list()).map(image => image.id)).toEqual([background.id]);
    await app.storage.initializeConversation(metadata('chat_b'), [message(2, '只留在机器 B 的聊天')]);
    const changed = await app.product.draft();
    changed.app.appearance.fontSize = 20;
    await changed.configs.deleteConfig(channel);
    await app.product.save(changed);
    await app.images.remove(background.id);
    await app.close(); app = undefined;

    app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: machineA, configurationPersistence: new DesktopPortableProfile(directory) });
    expect(app.settings.snapshot().settings.appearance.fontSize).toBe(20);
    expect(app.settings.snapshot().settings.workspaces.map(workspace => workspace.id)).toEqual(['project']);
    expect((await app.storage.listConversations()).items.map(conversation => conversation.id)).toEqual(['chat_a']);
    expect(await app.product.channel(channel)).toBeNull();
    expect(await app.images.list()).toEqual([]);
    // 模拟移动磁盘暂时不可写，旧配置仍完整，恢复后可重新保存。
    const unavailable = path.join(path.dirname(directory), 'portable-data-unavailable');
    expect(path.dirname(unavailable)).toBe(path.dirname(directory));
    await rename(directory, unavailable);
    const retry = await app.product.draft(); retry.app.appearance.fontSize = 21;
    expect((await app.product.save(retry)).activationWarnings?.join()).toContain('便携配置写入失败');
    await rename(unavailable, directory);
    expect((await app.product.save(await app.product.draft())).activationWarnings).toBeUndefined();
    expect(JSON.parse(await portableCodec.decrypt(await readFile(path.join(directory, 'settings.enc')))).settings.appearance.fontSize).toBe(21);
    await app.close(); app = undefined;

    await unlink(path.join(directory, 'profile.key'));
    const preserved = await readFile(path.join(directory, 'settings.enc'));
    await expect(PlatformApplication.open({ dataDirectory: f.data, secretCodec: machineA,
      configurationPersistence: new DesktopPortableProfile(directory) })).rejects.toThrow('profile.key');
    expect(await readFile(path.join(directory, 'settings.enc'))).toEqual(preserved);
  } finally { skills.mockRestore(); await app?.close(); await f.cleanup(); }
});

test('安装版与显式数据目录不启用便携配置，便携程序按 EXE 所在位置定位', async () => {
  const f = await fixture();
  try {
    const executable = path.join(f.root, 'current', 'GrayCode.exe');
    await mkdir(path.dirname(executable));
    expect(portableProfileDirectory(executable, true, false)).toBe(path.join(f.root, 'current', 'portable-data'));
    expect(portableProfileDirectory(executable, false, false)).toBeUndefined();
    expect(portableProfileDirectory(executable, true, true)).toBeUndefined();
    await writeFile(path.join(f.root, 'current', 'sq.version'), 'fixture');
    await writeFile(path.join(f.root, 'Update.exe'), 'fixture');
    expect(portableProfileDirectory(executable, true, false)).toBeUndefined();
  } finally { await f.cleanup(); }
});
