import { workspaceRoots } from '../workspace/paths';
import { validateDevelopmentSettings } from '../development/settings';
import { validateDiscordSettings } from '../bots/config';
import { validateRemoteAccess } from '../transport/webOrigin';
import { isMcpToolName } from '../../../../shared/mcpToolNameCodec';
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  AppSettings,
  SettingsDraft,
  SettingsSnapshot,
  RecordMutation,
} from "@graycode/contracts";
import { PlatformStorage, RuntimeToolRegistry } from "@graycode/core";
import { revealSettingsFields, sealSettingsFields } from './sealedFields';

export interface SecretCodec {
  encrypt(value: string): Promise<Uint8Array>;
  decrypt(value: Uint8Array): Promise<string>;
}
export interface PreparedSettingsProjection {
  records: RecordMutation[];
  credentials?: Record<string, string | null>;
  /** Prepared before the transaction; publishing must be synchronous and cannot fail. */
  publish(): void;
  activate?(): Promise<void>;
}
export interface SettingsProjection<T> {
  prepare(next: AppSettings, previous: AppSettings, value?: T): Promise<PreparedSettingsProjection>;
}
const namespace = "platform-settings";
const secretNamespace = "platform-secrets";
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;

export function initialSettings(toolNames: string[]): AppSettings {
  return {
    version: 1,
    appearance: {
      theme: "dark",
      uiFont: "Segoe UI, Microsoft YaHei, sans-serif",
      textFont: "inherit",
      codeFont: "Cascadia Code, Consolas, monospace",
      fontSize: 14,
      codeFontSize: 14,
      lineHeight: 1.6,
      density: "comfortable",
      colors: {},
      backgroundImage: "",
      backgroundOpacity: 0.12,
      customCss: "",
    },
    providers: [],
    workspaces: [],
    bindings: [],
    accounts: [
      {
        id: "owner",
        displayName: "主人",
        role: "owner",
        workspaceIds: "*",
        effects: [],
      },
    ],
    agents: [
      {
        id: "default",
        name: "GrayCode",
        providerId: "",
        systemPrompt:
          "You are GrayCode, a capable software engineering assistant. Work in the selected workspace and respect the authenticated account permissions. Read existing files before modifying them, preserve user changes, and verify meaningful changes. Use ask_user for optional clarifications while continuing independent work.",
        toolNames,
        approvalMode: "sensitive",
        maxIterations: 200,
      },
    ],
    discord: {
      enabled: false,
      allowedChannelIds: [],
      agentId: "default",
      mentionOnly: true,
    },
  };
}

/** One versioned document backs every settings section; secret changes share its transaction. */
export class SettingsService<T = never> {
  private current!: SettingsSnapshot;
  private projection?: SettingsProjection<T>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: PlatformStorage,
    private readonly tools: RuntimeToolRegistry,
    private readonly secrets?: SecretCodec,
    private readonly afterSave?: () => Promise<void>,
  ) {}
  async initialize(): Promise<void> {
    let record = await this.storage.getVersionedRecord(namespace, "main");
    if (record.value === null) {
      await this.storage.commitRecords([
        {
          namespace,
          id: "main",
          expectedRevision: null,
          value: initialSettings(
            this.tools.declarations().map((tool) => tool.name),
          ),
        },
      ]);
      record = await this.storage.getVersionedRecord(namespace, "main");
    }
    const credentialIds = await this.storage.listRecords(secretNamespace);
    this.current = {
      settings: await revealSettingsFields(record.value as AppSettings, reference => this.credential(reference)),
      revision: record.revision!,
      credentialIds,
    };
  }
  snapshot(): SettingsSnapshot {
    return structuredClone(this.current);
  }
  setProjection(projection: SettingsProjection<T>): void {
    if (this.projection) throw new Error('The settings projection is already installed.');
    this.projection = projection;
  }
  async credential(reference: string): Promise<string | null> {
    if (reference.startsWith("env:"))
      return process.env[reference.slice(4)] ?? null;
    if (!this.secrets) return null;
    const record = (await this.storage.getRecord(
      secretNamespace,
      reference,
    )) as { encrypted: Uint8Array } | null;
    return record ? this.secrets.decrypt(record.encrypted) : null;
  }
  save(draft: SettingsDraft, extension?: T): Promise<SettingsSnapshot> {
    // Freeze caller-owned drafts before waiting, and serialize publication with persistence.
    const input = structuredClone(draft);
    const value = structuredClone(extension);
    const operation = this.queue.catch(() => {}).then(() => this.commit(input, value));
    this.queue = operation;
    return operation;
  }
  private async commit(draft: SettingsDraft, extension?: T): Promise<SettingsSnapshot> {
    if (!Number.isSafeInteger(draft.expectedRevision) || draft.expectedRevision < 1)
      throw new Error('Supply the revision returned by settings.get before saving.');
    const next = structuredClone(draft.settings);
    const projection = await this.projection?.prepare(next, this.current.settings, extension);
    await this.validate(next);
    const sealed = sealSettingsFields(next, 'settings_provider_fields');
    const mutations: RecordMutation[] = [
      {
        namespace,
        id: "main",
        value: sealed.value,
        expectedRevision: draft.expectedRevision,
      },
    ];
    const credentialIds = new Set(this.current.credentialIds);
    const credentialUpdates = { ...draft.credentials, ...projection?.credentials, ...sealed.credentials };
    const remoteCredential = next.remoteAccess?.credentialRef;
    const previousRemoteCredential = this.current.settings.remoteAccess?.credentialRef;
    if (previousRemoteCredential && (previousRemoteCredential !== remoteCredential
      || Object.hasOwn(credentialUpdates, previousRemoteCredential)
        && credentialUpdates[previousRemoteCredential] !== await this.credential(previousRemoteCredential))) {
      // 停止入口期间更换令牌也撤销旧登录，之后改回旧值不会恢复已撤销的设备。
      mutations.push({ namespace: 'web-sessions', id: 'owner', delete: true });
    }
    if (remoteCredential && (next.remoteAccess?.enabled || Object.hasOwn(credentialUpdates, remoteCredential))) {
      const token = Object.hasOwn(credentialUpdates, remoteCredential) ? credentialUpdates[remoteCredential] : await this.credential(remoteCredential);
      if (typeof token !== 'string' || token.length < 32) throw new Error('远程访问令牌至少需要 32 个字符，请生成随机令牌。');
    }
    for (const [id, value] of Object.entries(credentialUpdates)) {
      if (!identifier.test(id))
        throw new Error("Invalid credential identifier.");
      if (value === null) {
        mutations.push({ namespace: secretNamespace, id, delete: true });
        credentialIds.delete(id);
      } else {
        if (!this.secrets)
          throw new Error(
            "Encrypted secret storage is unavailable. Use an explicit env:VARIABLE credential reference.",
          );
        if (typeof value !== "string" || !value.trim())
          throw new Error("Credential must not be empty.");
        mutations.push({
          namespace: secretNamespace,
          id,
          value: { encrypted: await this.secrets.encrypt(value) },
        });
        credentialIds.add(id);
      }
    }
    for (const reference of [
      ...next.providers.map((profile) => profile.credentialRef),
      next.discord.credentialRef,
      next.onebot?.credentialRef,
      next.remoteAccess?.credentialRef,
    ].filter(Boolean) as string[]) {
      if (!reference.startsWith("env:") && !credentialIds.has(reference))
        throw new Error(`Credential ${reference} has not been supplied.`);
    }
    const records = await this.storage.commitRecords([...mutations, ...projection?.records ?? []]);
    this.current = {
      settings: next,
      revision: records[0].revision!,
      credentialIds: [...credentialIds],
    };
    projection?.publish();
    // 本机事务已完成；便携副本失败必须随保存结果明确返回，允许用户重试。
    try { await this.afterSave?.(); }
    catch (error) { this.current.activationWarnings = [error instanceof Error ? error.message : String(error)]; }
    // A connector activation failure cannot roll back an already committed document.
    try { await projection?.activate?.(); }
    catch (error) { this.current.activationWarnings = [...this.current.activationWarnings ?? [], (error as Error).message]; }
    return this.snapshot();
  }
  private async validate(settings: AppSettings): Promise<void> {
    validateRemoteAccess(settings.remoteAccess);
    validateDevelopmentSettings(settings.development);
    if (settings.version !== 1)
      throw new Error("Unsupported settings version.");
    for (const entries of [
      settings.providers,
      settings.agents,
      settings.workspaces,
      settings.accounts,
      settings.bindings,
    ]) {
      if (!Array.isArray(entries) || (entries === settings.workspaces ? settings.workspaces.filter(item => !item?.managedConversationId).length : entries.length) > 256)
        throw new Error("Invalid settings collection.");
      const ids = new Set<string>();
      for (const item of entries) {
        if (!item || !identifier.test(item.id) || ids.has(item.id))
          throw new Error("Settings identifiers must be unique.");
        ids.add(item.id);
      }
    }
    if (
      settings.accounts.filter((account) => account.role === "owner").length !==
        1 ||
      !settings.accounts.some(
        (account) =>
          account.id === "owner" &&
          account.role === "owner" &&
          !account.revoked,
      )
    )
      throw new Error("The deployment owner must remain available.");
    for (const account of settings.accounts) {
      if (
        !["owner", "member", "guest"].includes(account.role) ||
        !Array.isArray(account.effects) ||
        (account.workspaceIds !== "*" && !Array.isArray(account.workspaceIds))
      )
        throw new Error("Invalid account grant.");
      if (account.botWorkspaceAccess !== undefined && typeof account.botWorkspaceAccess !== 'boolean') throw new Error('机器人专用工作区权限必须是布尔值。');
      if (account.mcpTools !== undefined && (!Array.isArray(account.mcpTools) || account.mcpTools.some(name => typeof name !== 'string' || !isMcpToolName(name))
        || new Set(account.mcpTools).size !== account.mcpTools.length)) throw new Error('MCP 授权必须是具体工具名称，且不能重复。');
    }
    if (settings.botGuestAccountId && !settings.accounts.some(account => account.id === settings.botGuestAccountId && account.role !== 'owner'))
      throw new Error('未绑定用户的默认权限必须选择非主人账号。');
    for (const workspace of settings.workspaces) {
      if (workspace.managedConversationId !== undefined && !identifier.test(workspace.managedConversationId)) throw new Error('自动工作区的对话标识无效。');
      const previous = this.current?.settings.workspaces.find(item => item.id === workspace.id);
      if (workspace.managedConversationId && previous?.managedConversationId === workspace.managedConversationId
        && previous.directory === workspace.directory && previous.deviceId === workspace.deviceId && previous.name === workspace.name
        && JSON.stringify(previous.roots) === JSON.stringify(workspace.roots)) continue;
      if (
        workspace.deviceId !== "local" ||
        !path.isAbsolute(workspace.directory)
      )
        throw new Error("Choose an absolute directory on the local device.");
      if (workspace.roots !== undefined && (!Array.isArray(workspace.roots) || !workspace.roots.length || workspace.roots.length > 256))
        throw new Error('工作区至少需要一个目录，最多支持 256 个目录。');
      const roots = workspaceRoots(workspace); const names = new Set<string>(); const directories = new Set<string>();
      for (const root of roots) {
        if (!root || typeof root.directory !== 'string' || !path.isAbsolute(root.directory)) throw new Error('请选择目录的绝对路径。');
        if (typeof root.name !== 'string' || !root.name.trim() || roots.length > 1 && (/[/\\\0]/.test(root.name) || names.has(root.name.toLowerCase())))
          throw new Error('每个目录需要不同的名称，名称不能包含斜杠。');
        root.directory = await realpath(root.directory);
        if (!(await stat(root.directory)).isDirectory()) throw new Error('工作区路径不是目录。');
        const identity = process.platform === 'win32' ? root.directory.toLowerCase() : root.directory;
        if (directories.has(identity)) throw new Error('同一工作区不能重复添加相同的目录。');
        directories.add(identity); names.add(root.name.toLowerCase());
      }
      workspace.directory = await realpath(workspace.directory);
      if (path.relative(roots[0].directory, workspace.directory) !== '') throw new Error('工作区的默认目录必须是目录列表的第一项。');
    }
    for (const profile of settings.providers) {
      if (
        ![
          "openai",
          "openai-responses",
          "anthropic",
          "gemini",
          "gemini-interactions",
        ].includes(profile.protocol)
      )
        throw new Error("Unsupported provider protocol.");
      const url = new URL(profile.endpoint);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          "Provider endpoint must be HTTP(S) without embedded credentials.",
        );
      // 未选模型的渠道可以保存，具体发送时再要求有效模型，与旧版设置保持一致。
      if (typeof profile.model !== 'string') throw new Error(`渠道「${profile.name || profile.id}」的默认模型格式无效。`);
      if (!Number.isFinite(profile.timeoutMs) || profile.timeoutMs <= 0)
        throw new Error(`渠道「${profile.name || profile.id}」的请求超时必须是大于 0 的毫秒数，请在该渠道的高级设置中修改。`);
      if (
        !profile.capabilities ||
        !Array.isArray(profile.capabilities.reasoningLevels) ||
        !profile.capabilities.compatibility
      )
        throw new Error("Provider capabilities must be explicit.");
      if (
        Object.keys(profile.customHeaders ?? {}).some((key) =>
          /authorization|api[-_]?key|cookie/i.test(key),
        )
      )
        throw new Error(
          "Store authentication in the credential field, not in custom headers.",
        );
    }
    for (const [mode, profile] of Object.entries(settings.modeProfiles ?? {})) {
      if (!['chat', 'code', 'character'].includes(mode) || !profile ||
        profile.promptModeId !== undefined && typeof profile.promptModeId !== 'string' ||
        profile.toolNames !== undefined && (!Array.isArray(profile.toolNames) || profile.toolNames.some(name => typeof name !== 'string')))
        throw new Error('对话模式配置无效。');
    }
    for (const agent of settings.agents) {
      if (agent.modelId !== undefined && (typeof agent.modelId !== 'string' || !agent.modelId.trim())) throw new Error('智能体默认模型格式无效。');
      this.tools.catalog(agent.toolNames);
      if (agent.reviewerToolNames !== undefined && (!Array.isArray(agent.reviewerToolNames) || agent.reviewerToolNames.some(name => typeof name !== 'string' || !name))) throw new Error('审核工具列表无效。');
      if (
        agent.providerId &&
        !settings.providers.some((profile) => profile.id === agent.providerId)
      )
        throw new Error("Agent provider does not exist.");
      if (
        agent.reviewerProviderId &&
        !settings.providers.some(
          (profile) => profile.id === agent.reviewerProviderId,
        )
      )
        throw new Error("Reviewer provider does not exist.");
      if (
        !Number.isSafeInteger(agent.maxIterations) ||
        (agent.maxIterations !== -1 && agent.maxIterations < 1)
      )
        throw new Error("Invalid iteration limit.");
      if (
        !["sensitive", "all_mutations"].includes(agent.approvalMode) ||
        Object.values(agent.toolApproval ?? {}).some(
          (rule) => !["auto", "ask", "deny"].includes(rule),
        )
      )
        throw new Error("Invalid approval policy.");
    }
    const bindings = new Set<string>();
    for (const binding of settings.bindings) {
      const key = JSON.stringify([binding.platform, binding.platform === 'onebot' ? binding.network ?? 'qq' : '', binding.platformUserId]);
      if (
        !["discord", "onebot"].includes(binding.platform) ||
        (binding.platform === 'discord' ? !/^\d+$/.test(binding.platformUserId) : typeof binding.platformUserId !== 'string' || !binding.platformUserId.trim()) ||
        bindings.has(key) ||
        typeof binding.accountId !== 'string' || binding.accountId !== '' && !settings.accounts.some((account) => account.id === binding.accountId)
      )
        throw new Error("Invalid or duplicate platform identity binding.");
      if (binding.blocked !== undefined && typeof binding.blocked !== 'boolean') throw new Error('拉黑状态必须是布尔值。');
      bindings.add(key);
    }
    for (const bot of [settings.discord, settings.onebot]) {
      if (bot?.autoConnect !== undefined && typeof bot.autoConnect !== 'boolean') throw new Error('Bot 自动连接选项必须是布尔值。');
    }
    if (settings.onebot) {
      const onebot = settings.onebot;
      if (onebot.protocolVersion !== undefined && ![11, 12].includes(onebot.protocolVersion)) throw new Error('OneBot 协议版本无效。');
      const address = onebot.protocolVersion === 12 ? /^(?:(?:group|private):[^:]+|channel:[^:]+:[^:]+)$/ : /^(group|private):\d+$/;
      if (!Array.isArray(onebot.allowedChannelIds) || onebot.allowedChannelIds.some(id => !address.test(id))) throw new Error('OneBot 会话地址格式无效。');
      if (onebot.protocolVersion === 12 && onebot.enabled && (!onebot.self?.platform || !onebot.self.userId)) throw new Error('OneBot 12 需要填写机器人平台和用户 ID。');
      if (onebot.endpoint) {
        const endpoint = new URL(onebot.endpoint);
        if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
          throw new Error('请填写不含密钥参数的 OneBot WebSocket 地址，访问令牌单独保存。');
      }
      if (onebot.enabled && (!onebot.endpoint || !onebot.allowedChannelIds.length || !settings.agents.some(agent => agent.id === onebot.agentId)))
        throw new Error('启用 OneBot 前请配置地址、允许的会话和智能体。');
      if (onebot.workspaceId && !settings.workspaces.some(workspace => workspace.id === onebot.workspaceId)) throw new Error('OneBot 工作区不存在。');
    }
    const bot = settings.discord;
    if (
      !bot ||
      !Array.isArray(bot.allowedChannelIds) ||
      bot.allowedChannelIds.some((id) => !/^\d+$/.test(id))
    )
      throw new Error("Invalid Discord channel list.");
    validateDiscordSettings(settings);
    if (
      bot.enabled &&
      (!bot.credentialRef ||
        !settings.agents.some((agent) => agent.id === bot.agentId))
    )
      throw new Error(
        '请先配置 Discord Token 和智能体。连接后可选择允许响应的频道。',
      );
    if (
      bot.workspaceId &&
      !settings.workspaces.some((workspace) => workspace.id === bot.workspaceId)
    )
      throw new Error("Discord workspace does not exist.");
    const appearance = settings.appearance;
    if (
      !appearance ||
      !["dark", "light", "system"].includes(appearance.theme) ||
      !Number.isFinite(appearance.fontSize) ||
      appearance.fontSize < 10 ||
      appearance.fontSize > 30 ||
      !Number.isFinite(appearance.codeFontSize) ||
      appearance.codeFontSize < 10 ||
      appearance.codeFontSize > 30 ||
      !Number.isFinite(appearance.lineHeight) ||
      appearance.lineHeight < 1 ||
      appearance.lineHeight > 3 ||
      !Number.isFinite(appearance.backgroundOpacity) ||
      appearance.backgroundOpacity < 0 ||
      appearance.backgroundOpacity > 1 ||
      typeof appearance.customCss !== "string" ||
      appearance.customCss.length > 100_000
    )
      throw new Error("Invalid appearance settings.");
  }
}
