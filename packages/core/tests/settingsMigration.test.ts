import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ChannelConfig } from '../../../backend/modules/config/types';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { SettingsTransfer } from '../../../apps/server/src/settings/transfer';
import type { ConfigurationReport } from '../../../apps/server/src/migration/configuration';
import { pad } from '../../../backend/modules/memory/logFormat';
import { LOG_REC, TREE_REC, DEFAULT_MEMORY_CONFIG } from '../../../backend/modules/memory/types';
import { buildConfigContent } from '../../../backend/modules/memory/configFile';
import { SkillsRuntime } from '../../../backend/modules/skills/SkillsRuntime';
import { fixture, message, metadata } from './fixtures';

describe('旧设置与附属资源迁移', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter;
  const key = randomBytes(32);
  const codec = {
    encrypt: async (text: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), content]); },
    decrypt: async (value: Uint8Array) => { const bytes = Buffer.from(value); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
  };
  const owner = { actorId: 'owner', clientId: 'migration-settings' };
  const ui = <T = any>(type: string, data: Record<string, unknown> = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<T>;
  const open = async () => { app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec,
    models: { generate: async () => { throw new Error('此迁移验证不得调用模型。'); } } }); router = new ApplicationRouter(app); };
  beforeEach(async () => { f = await fixture(); await f.store.close(); await open(); });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

  test('已打开渠道页时导入新渠道，覆盖旧参数并保持保存、撤销和重启语义', async () => {
    const baseline = await app.product.draft();
    await baseline.configs.createConfig({ name: '原渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', apiKey: 'BEFORE_IMPORT_KEY', model: 'fixture-model', enabled: true, timeout: 5000 }, 'existing');
    await baseline.configs.updateConfig('existing', { apiKey: 'BEFORE_IMPORT_KEY', model: 'fixture-model', url: 'http://127.0.0.1:1/v1', options: { frequency_penalty: 0.75 } });
    await app.product.save(baseline);
    const existing = (await app.product.channel('existing'))!;
    const incoming = { ...existing, name: '导入后的渠道', apiKey: 'AFTER_IMPORT_KEY', options: { ...existing.options, temperature: 0.2 } } as ChannelConfig;
    delete (incoming.options as Record<string, unknown>).frequency_penalty;
    const fresh = { ...incoming, id: 'fresh', name: '新导入渠道', apiKey: 'NEW_IMPORT_KEY' };
    const value = { version: '1.0', exportedAt: 1000, limcodeVersion: '1.4', vscodeSettings: { 'limcode.toolsEnabled': { read_file: false } },
      channelConfigs: [incoming, fresh], mcpServers: [], skills: [{ id: 'old-skill', name: 'old-skill', description: '旧格式技能', content: '原始正文', source: 'user-limcode', enabled: false }] };
    await ui('ui.settings.begin');
    await ui('config.getConfig', { configId: 'existing' }); // 先装载缓存，再模拟从设置页导入文件。
    const commands: string[] = []; const unsubscribe = app.subscribe(event => { if (event.type === 'ui.message' && event.clientId === owner.clientId) commands.push((event.message as { command?: string }).command ?? ''); });
    expect(await ui('settings.importData', { value })).toMatchObject({ success: true, imported: { channelConfigs: 2, skills: 1 } });
    unsubscribe(); expect(commands).toEqual(expect.arrayContaining(['channels.configChanged', 'mcp.configChanged', 'settings.imported']));
    expect(await ui('config.getConfig', { configId: 'fresh' })).toMatchObject({ name: '新导入渠道', apiKey: 'NEW_IMPORT_KEY' });
    expect((await ui('config.getConfig', { configId: 'existing' })).options).not.toHaveProperty('frequency_penalty');
    expect(await app.product.channel('fresh')).toBeNull();
    await ui('ui.settings.discard');
    expect(await ui('config.getConfig', { configId: 'fresh' })).toBeNull();
    expect((await app.product.channel('existing'))?.apiKey).toBe('BEFORE_IMPORT_KEY');
    expect(await ui('settings.importData', { value })).toMatchObject({ success: true });
    await ui('ui.settings.save'); await ui('ui.settings.end');
    expect((await app.product.channel('fresh'))?.apiKey).toBe('NEW_IMPORT_KEY');
    expect(app.product.runtimeSettings().getSettings().toolsEnabled.read_file).toBe(false);
    expect(app.product.importedSkills[0]).toMatchObject({ source: 'user-graycode', enabled: false });
    expect(value.skills[0].source).toBe('user-limcode'); // 调用者的导入原件没有被格式转换改写。
    expect(JSON.stringify(await app.storage.getRecord('product-settings', 'main'))).not.toContain('NEW_IMPORT_KEY');
    await app.close(); await open();
    expect(await app.product.channel('existing')).toMatchObject({ name: '导入后的渠道', apiKey: 'AFTER_IMPORT_KEY' });
    expect((await app.product.channel('existing'))?.options).not.toHaveProperty('frequency_penalty');
    expect((await app.product.channel('fresh'))?.apiKey).toBe('NEW_IMPORT_KEY');
  });

  test('设置导出包含草稿新增密钥，并且不恢复已删除密钥', async () => {
    const current = app.settings.snapshot();
    await app.settings.save({ settings: current.settings, expectedRevision: current.revision, credentials: { deleted_secret: 'DO_NOT_EXPORT', retained_secret: 'KEEP_ME' } });
    const draft = await app.product.draft(); draft.credentials.deleted_secret = null; draft.credentials.pending_secret = 'DRAFT_ONLY';
    jest.spyOn(app.skills, 'export').mockResolvedValue([]); // 本用例只验证密钥，不扫描宿主的技能目录。
    const exported = await new SettingsTransfer(app).export(draft);
    expect(exported.credentials).toEqual({ retained_secret: 'KEEP_ME', pending_secret: 'DRAFT_ONLY' });
    expect(await app.settings.credential('deleted_secret')).toBe('DO_NOT_EXPORT');
    expect(await app.settings.credential('pending_secret')).toBeNull();
  });

  test('旧设置导入保留提示词预设和原来的当前预设', async () => {
    const original = app.product.runtimeSettings().getSystemPromptConfig();
    const base = original.modes.code;
    const legacyMode = { ...base, id: 'legacy-graywill', name: '灰魂旧预设' };
    const toolsConfig = structuredClone(app.product.runtimeSettings().getSettings().toolsConfig)!;
    toolsConfig.system_prompt = { ...original, currentModeId: 'code',
      modes: { ...original.modes, [legacyMode.id]: legacyMode } };
    const value = { version: '1.0', graycodeVersion: '1.5.6', exportedAt: 1000,
      vscodeSettings: { toolsConfig }, channelConfigs: [], mcpServers: [], skills: [] };

    await ui('ui.settings.begin');
    expect(await ui('settings.importData', { value })).toMatchObject({ success: true, imported: { vscodeSettings: true } });
    const staged = await ui('getPromptModes');
    expect(staged.currentModeId).toBe('code');
    expect(staged.modes).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacyMode.id, name: legacyMode.name })]));
    await ui('ui.settings.save'); await ui('ui.settings.end');

    await app.close(); await open();
    expect(app.product.runtimeSettings().getCurrentPromptModeId()).toBe('code');
    expect(app.product.runtimeSettings().getAllPromptModes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: legacyMode.id, name: legacyMode.name })]));
  });

  test('实际旧目录迁移保留技能资源、LOG/TREE、活动和依赖，旧文件设置需保存后才完成', async () => {
    const project = path.join(f.root, 'project'); await mkdir(project);
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push({ id: 'project', name: '旧项目', directory: project, deviceId: 'local' });
    settings.settings.accounts.push({ id: 'reader', displayName: '读取验证', role: 'member', effects: ['workspace_read'], workspaceIds: ['project'] });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    const sources = new Map<string, Buffer>();
    async function source(relative: string, bytes: string | Uint8Array) {
      const file = path.join(f.source, relative); await mkdir(path.dirname(file), { recursive: true });
      const content = Buffer.from(bytes); sources.set(file, content); await writeFile(file, content);
    }
    await source('conversations/archive.meta.json', JSON.stringify(metadata('archive')));
    await source('conversations/archive.json', JSON.stringify([message(0, '需要完整保留的旧历史')]));
    await source('settings/settings.json', JSON.stringify({ ui: { language: 'en' }, toolsEnabled: { read_file: false }, storagePath: path.join(f.root, 'must-not-use') }));
    const binary = Buffer.from([0, 128, 255, 13, 10]);
    await source('skills/migration-skill/SKILL.md', '---\nname: migration-skill\ndescription: 保留附属资源的示例\n---\n正文引用 assets/sample.bin。');
    await source('skills/migration-skill/assets/sample.bin', binary);
    await source('skills/migration-skill/scripts/check.cjs', `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, 'must-not-execute'))},'executed')`);
    await source('memory/LOG.txt', Buffer.concat([pad('#0 2026-09-01 第一条全局记忆', LOG_REC), pad('#1 2026-09-02 第二条全局记忆', LOG_REC)]));
    await source('memory/TREE/2', pad('两条全局记忆的原摘要', TREE_REC));
    await source('memory/config', buildConfigContent(DEFAULT_MEMORY_CONFIG));
    await source('memory-workspaces/previous/scope.json', JSON.stringify({ fsPath: project, uri: pathToFileURL(project).toString() }));
    await source('memory-workspaces/previous/LOG.txt', pad('#0 2026-09-03 独立项目记忆', LOG_REC));
    const sample = Date.parse('2026-09-01T12:00:00+08:00');
    await source('activity/2026-09-01.json', JSON.stringify({ date: '2026-09-01', samples: [sample, sample + 1000] }));
    await source('dependencies/node_modules/fixture-package/package.json', JSON.stringify({ name: 'fixture-package', version: '1.0.0', scripts: { postinstall: 'exit 99' } }));
    await source('dependencies/node_modules/fixture-package/asset.bin', binary);
    await mkdir(path.join(f.source, 'dependencies', 'empty'), { recursive: true });
    await ui('ui.settings.begin');
    const report = await ui<ConfigurationReport>('migration.import', { source: f.source });
    expect(report.issues).toEqual([]); expect(report.pendingArtifacts).toEqual([]); expect(report.readyForCutover).toBe(false);
    expect(report.skills?.imported).toEqual(['migration-skill']); expect(report.memory?.imported).toHaveLength(2); expect(report.activity?.imported).toEqual(['2026-09-01']);
    expect(report.runtimeAssets?.imported).toEqual(['dependencies']);
    expect(await readFile(path.join(f.data, 'dependencies/node_modules/fixture-package/asset.bin'))).toEqual(binary);
    expect((await stat(path.join(f.data, 'dependencies/empty'))).isDirectory()).toBe(true);
    const global = app.memory.scope('owner'); const local = app.memory.scope('owner', app.workspace('owner', 'project', ['workspace_read']));
    expect((await app.storage.memoryEntries(global, 0, 10)).map(entry => entry.text)).toEqual(['第一条全局记忆', '第二条全局记忆']);
    expect((await app.storage.memorySummaries(global)).map(summary => summary.text)).toEqual(['两条全局记忆的原摘要']);
    expect((await app.storage.memoryEntries(local, 0, 10)).map(entry => entry.text)).toEqual(['独立项目记忆']);
    const context = { runId: 'skill-read', actorId: 'reader', actor: app.actor('reader')!, workspace: app.workspace('reader', 'project', ['workspace_read']),
      signal: new AbortController().signal, progress: () => {}, askUser: async () => { throw new Error('unused'); } };
    expect((await app.skills.tool().execute({ name: 'migration-skill' }, context)).success).toBe(false);
    // 已导入的私人技能仅向主人提供；本次只验证导入包，不扫描真实用户的其他技能。
    const scan = jest.spyOn(SkillsRuntime.prototype, 'refresh').mockResolvedValue();
    const skill = await app.skills.tool().execute({ name: 'migration-skill' }, { ...context, actorId: 'owner', actor: app.actor('owner')! });
    scan.mockRestore();
    if (!skill.success) throw new Error(skill.error || JSON.stringify(skill));
    const base = (skill.data as { basePath: string }).basePath;
    expect(await readFile(path.join(base, 'assets/sample.bin'))).toEqual(binary);
    await expect(stat(path.join(f.root, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' });
    const file = report.configurationFiles!.find(file => file.path === 'settings/settings.json')!; expect(file).toBeDefined();
    await ui('migration.stageConfiguration', { operationId: report.operationId, fileId: file.id });
    await ui('ui.settings.discard');
    expect((await ui<ConfigurationReport>('migration.report', { operationId: report.operationId })).configurationFiles?.[0].saved).toBe(false);
    expect(app.product.runtimeSettings().getUISettings().language).not.toBe('en');
    await ui('migration.stageConfiguration', { operationId: report.operationId, fileId: file.id }); await ui('ui.settings.save');
    expect((await ui<ConfigurationReport>('migration.report', { operationId: report.operationId })).readyForCutover).toBe(true);
    expect(app.product.runtimeSettings().getUISettings().language).toBe('en'); expect(app.storage.directory).toBe(f.data);
    const repeated = await ui<ConfigurationReport>('migration.import', { source: f.source });
    expect(repeated.issues).toEqual([]); expect(repeated.skills?.skipped).toEqual(['migration-skill']); expect(repeated.memory?.skipped).toHaveLength(2);
    expect(repeated.activity?.skipped).toEqual(['2026-09-01']); expect(repeated.runtimeAssets?.skipped).toEqual(['dependencies']);
    expect(await app.storage.getRecord('activity-samples', 'owner_2026-09-01')).toMatchObject({ samples: [sample, sample + 1000] });
    expect((await app.storage.memoryEntries(global, 0, 10))).toHaveLength(2);
    for (const [file, bytes] of sources) expect(await readFile(file)).toEqual(bytes);
  });
});
