import { DEFAULT_BRANCH_RETENTION_DAYS, branchRetentionDays } from '../conversations/retention';
import type { PendingConfigurationImport } from '../migration/configuration';
import type { MemoryConfig } from '../../../../backend/modules/memory/types';
import type { SavedPlatformSkill, SkillBundle } from '../skills/bundles';
import { SettingsManager } from '../../../../backend/modules/settings/SettingsManager';
import type { GlobalSettings } from '../../../../backend/modules/settings/types';
import { ConfigManager } from '../../../../backend/modules/config/ConfigManager';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import type { AppSettings, SettingsSnapshot } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { McpManager } from '../../../../backend/modules/mcp/McpManager';
import type { McpServerConfig } from '../../../../backend/modules/mcp/types';
import { createMcpSettingsDraft, revealMcpSettings, sealMcpSettings } from '../mcp/settings';
import type { PreparedSettingsProjection } from './service';
import { channelProfile, projectChannels } from './providers';
import { revealSettingsFields, sealSettingsFields } from './sealedFields';
import { isDeepStrictEqual } from 'node:util';

export interface ProductPreferences { branchRetentionDays?: number; pendingConfigurationImports?: PendingConfigurationImport[]; pendingMemoryConfig?: { scopeId: string; value: MemoryConfig; expectedRevision: number | null }; pendingSkillBundles?: Record<string, SkillBundle>; importedSkills?: SavedPlatformSkill[]; features: GlobalSettings; channels: ChannelConfig[]; mcpServers?: McpServerConfig[]; mcpSecrets?: Record<string, string> }
export interface ProductSettingsDraft {
  memoryConfig?: { scopeId: string; value: MemoryConfig; expectedRevision: number | null; dirty: boolean };
  settings: SettingsManager;
  configs: ConfigManager;
  mcp: McpManager;
  app: AppSettings;
  credentials: Record<string, string | null>;
  revision: number;
  value: ProductPreferences;
  dirty: boolean;
  baseApp: AppSettings;
  basePreferences: ProductPreferences;
}
const secretPlaceholder = '••••••••';
const reference = (id: string) => `channel_${id}`;

/** Preserve the existing feature/configuration services; only their persistence host changes. */
export class ProductConfiguration {
  private saved!: ProductPreferences;
  private activeSettings!: SettingsManager;
  constructor(private readonly application: PlatformApplication) {}
  async initialize(): Promise<void> {
    const raw = await this.application.storage.getRecord('product-settings', 'main') as ProductPreferences | null;
    const persisted = raw ? await revealSettingsFields(raw, reference => this.application.settings.credential(reference)) : null;
    const manager = new SettingsManager({ load: async () => persisted?.features ?? null, save: async () => {} });
    await manager.initialize();
    this.activeSettings = manager;
    const profiles = this.application.settings.snapshot().settings.providers;
    this.saved = { features: structuredClone(manager.getSettings()), channels: projectChannels(profiles, persisted?.channels ?? [], profiles) };
    this.saved.branchRetentionDays = persisted?.branchRetentionDays;
    this.saved.importedSkills = persisted?.importedSkills ?? [];
    if (!persisted?.importedSkills) {
      for (const id of await this.application.storage.listRecords('imported-skills')) {
        const skill = await this.application.storage.getRecord('imported-skills', id);
        try { this.saved.importedSkills.push(this.application.skills.validateImport(skill)); }
        catch (error) { console.warn('[Skills] 已保留无法识别的旧导入记录：', error); }
      }
    }
    this.saved.mcpSecrets = persisted?.mcpSecrets ?? {};
    this.saved.mcpServers = await revealMcpSettings(persisted?.mcpServers ?? [], this.saved.mcpSecrets, reference => this.application.settings.credential(reference));
    this.application.settings.setProjection(this);
    this.application.refreshMutationTools();
  }
  get branchRetentionDays(): number { return this.saved.branchRetentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS; }
  get importedSkills(): SavedPlatformSkill[] { return structuredClone(this.saved.importedSkills ?? []); }
  get features(): GlobalSettings { return structuredClone(this.saved.features); }
  runtimeSettings(): SettingsManager { return this.activeSettings; }
  mcpConfigs(): McpServerConfig[] { return structuredClone(this.saved.mcpServers ?? []); }
  async channel(id: string): Promise<ChannelConfig | null> {
    const config = this.saved.channels.find(channel => channel.id === id);
    if (!config) return null;
    const profile = this.application.settings.snapshot().settings.providers.find(profile => profile.id === id);
    return { ...structuredClone(config), apiKey: profile?.credentialRef ? await this.application.settings.credential(profile.credentialRef) ?? '' : '' } as ChannelConfig;
  }
  async draft(input?: ProductSettingsDraft): Promise<ProductSettingsDraft> {
    const snapshot = input ? { settings: structuredClone(input.app), revision: input.revision } : this.application.settings.snapshot();
    const value = structuredClone(input?.value ?? this.saved);
    if (!input) for (const channel of value.channels) {
      const profile = snapshot.settings.providers.find(profile => profile.id === channel.id);
      channel.apiKey = profile?.credentialRef ? secretPlaceholder : '';
    }
    const draft = { value, app: snapshot.settings, credentials: structuredClone(input?.credentials ?? {}), revision: snapshot.revision, dirty: input?.dirty ?? false,
      memoryConfig: input?.memoryConfig ? structuredClone(input.memoryConfig) : undefined,
      baseApp: structuredClone(input?.baseApp ?? snapshot.settings), basePreferences: structuredClone(input?.basePreferences ?? this.saved) } as ProductSettingsDraft;
    draft.settings = new SettingsManager({ load: async () => value.features,
      save: async settings => { value.features = structuredClone(settings); draft.dirty = true; } });
    await draft.settings.initialize();
    draft.mcp = createMcpSettingsDraft(value, () => { draft.dirty = true; });
    await draft.mcp.initialize();
    draft.configs = new ConfigManager({
      list: async () => value.channels.map(channel => channel.id),
      exists: async id => value.channels.some(channel => channel.id === id),
      load: async id => structuredClone(value.channels.find(channel => channel.id === id) ?? null),
      delete: async id => { value.channels = value.channels.filter(channel => channel.id !== id); draft.dirty = true; },
      save: async channel => {
        const index = value.channels.findIndex(item => item.id === channel.id);
        if (index < 0) value.channels.push(structuredClone(channel)); else value.channels[index] = structuredClone(channel);
        draft.dirty = true;
      },
    });
    return draft;
  }
  async save(draft: ProductSettingsDraft): Promise<SettingsSnapshot> {
    const current = this.application.settings.snapshot();
    if (current.revision !== draft.revision) {
      const { workspaces: previousWorkspaces, ...previousSettings } = draft.baseApp;
      const { workspaces: currentWorkspaces, ...currentSettings } = current.settings;
      // 主界面添加工作区不应使打开中的设置作废；其他并发修改仍交由版本冲突处理。
      if (isDeepStrictEqual(previousSettings, currentSettings) && isDeepStrictEqual(this.saved, draft.basePreferences)
        && isDeepStrictEqual(draft.app.workspaces, previousWorkspaces)) {
        draft.app.workspaces = structuredClone(currentWorkspaces);
        draft.revision = current.revision;
      }
    }
    const channels = structuredClone(draft.value.channels);
    const next = structuredClone(draft.app);
    const credentials = { ...draft.credentials };
    const profiles = new Map(next.providers.map(profile => [profile.id, profile]));
    next.providers = channels.map(channel => {
      const previous = profiles.get(channel.id);
      let credentialRef = previous?.credentialRef;
      if (channel.apiKey !== secretPlaceholder) {
        if (channel.apiKey) { credentialRef = reference(channel.id); credentials[credentialRef] = channel.apiKey; }
        else credentialRef = undefined;
      }
      channel.apiKey = '';
      return channelProfile(channel, previous, credentialRef);
    });
    const active = draft.settings.getActiveChannelId();
    for (const agent of next.agents) {
      if (!agent.providerId || !next.providers.some(profile => profile.id === agent.providerId)) agent.providerId = active || next.providers[0]?.id || '';
    }
    const snapshot = await this.application.settings.save({ settings: next, expectedRevision: draft.revision, credentials },
      { ...draft.value, channels, ...(draft.memoryConfig?.dirty ? { pendingMemoryConfig: draft.memoryConfig } : {}) });
    draft.memoryConfig = undefined;
    delete draft.value.pendingSkillBundles;
    delete draft.value.pendingConfigurationImports;
    draft.revision = snapshot.revision; draft.app = snapshot.settings; draft.credentials = {}; draft.dirty = false;
    draft.baseApp = structuredClone(snapshot.settings); draft.basePreferences = structuredClone(this.saved);
    for (const channel of draft.value.channels) channel.apiKey = snapshot.settings.providers.find(profile => profile.id === channel.id)?.credentialRef ? secretPlaceholder : '';
    return snapshot;
  }
  async prepare(next: AppSettings, previous: AppSettings, value?: ProductPreferences): Promise<PreparedSettingsProjection> {
    const saved = structuredClone(value ?? this.saved);
    if (saved.branchRetentionDays !== undefined) branchRetentionDays(saved.branchRetentionDays);
    const memoryConfig = saved.pendingMemoryConfig;
    delete saved.pendingMemoryConfig;
    const configurationImports = saved.pendingConfigurationImports ?? [];
    delete saved.pendingConfigurationImports;
    const skillBundles = saved.pendingSkillBundles ?? {};
    delete saved.pendingSkillBundles;
    saved.channels = projectChannels(next.providers, saved.channels, previous.providers);
    const credentials: Record<string, string | null> = {};
    const mcp = sealMcpSettings(saved.mcpServers ?? [], this.saved.mcpSecrets ?? {}, credentials);
    saved.mcpSecrets = mcp.references;
    const activeSettings = new SettingsManager({ load: async () => saved.features, save: async () => {} });
    await activeSettings.initialize();
    const sealed = sealSettingsFields({ ...saved, mcpServers: mcp.configs }, 'settings_product_fields');
    return {
      records: [{ namespace: 'product-settings', id: 'main', value: sealed.value },
        ...Object.entries(skillBundles).map(([id, value]) => ({ namespace: 'skill-bundles', id, value })),
        ...configurationImports.map(value => ({ namespace: 'migration-configurations', id: value.id, value: { ...value, importedAt: Date.now() } })),
        ...(memoryConfig ? [{ namespace: 'memory-config', id: memoryConfig.scopeId, value: memoryConfig.value, expectedRevision: memoryConfig.expectedRevision }] : [])], credentials: { ...credentials, ...sealed.credentials },
      publish: () => { this.saved = saved; this.activeSettings = activeSettings; this.application.refreshMutationTools(); this.application.files.rebindWorkspaces(previous.workspaces, next.workspaces); },
      activate: async () => {
        this.application.publish({ type: 'settings.changed', revision: this.application.settings.snapshot().revision });
        if (configurationImports.length) this.application.publish({ type: 'ui.message', message: { type: 'command', command: 'migration.configuration.saved',
          data: { operationIds: [...new Set(configurationImports.map(item => item.reportId))] } } });
        await this.application.languages.configure();
        await this.application.mcp.synchronize();
      },
    };
  }
}
