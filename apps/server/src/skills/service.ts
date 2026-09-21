import { workspaceRoots } from '../workspace/paths';
import path from 'node:path';
import os from 'node:os';
import type { ActorIdentity, WorkspaceDefinition, ToolDeclaration } from '@graycode/contracts';
import type { RuntimeTool } from '@graycode/core';
import { SkillsRuntime } from '../../../../backend/modules/skills/SkillsRuntime';
import type { Skill } from '../../../../backend/modules/skills/types';
import type { SkillConfigItem } from '../../../../backend/modules/settings/types/skillsTypes';
import type { SkillExportData } from '../../../../backend/modules/settings/SettingsExporter';
import { createSkillReadRuntime } from '../../../../backend/tools/skills/readSkillRuntime';
import type { PlatformApplication } from '../application';
import type { ProductSettingsDraft } from '../settings/product';
import { SkillBundleStore, collectSkillBundle, skillBundleId, validateSkillBundle, type PlatformSkillExport, type SavedPlatformSkill } from './bundles';

function configs(value: unknown): SkillConfigItem[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is SkillConfigItem => !!item &&
    typeof item.id === 'string' && typeof item.enabled === 'boolean') : undefined;
}

/** 技能目录按任务工作区与账号范围装配，不改写其他任务的全局工具目录。 */
export class PlatformSkills {
  readonly bundles: SkillBundleStore;
  constructor(private readonly app: PlatformApplication) { this.bundles = new SkillBundleStore(app); }
  directory() { return path.join(os.homedir(), '.graycode', 'skills'); }
  private async scan(actor: ActorIdentity, workspace?: WorkspaceDefinition): Promise<Skill[]> {
    if (actor.role !== 'owner' && !actor.effects.includes('workspace_read')) return [];
    const manager = new SkillsRuntime({ workspacePath: workspace?.directory, globalStoragePath: this.app.storage.directory,
      includeUserSkills: actor.role === 'owner', host: { workspacePaths: () => workspace ? workspaceRoots(workspace).map(root => root.directory) : [],
        ...(actor.role !== 'owner' && workspace ? { resolvePath: (file: string) => this.app.files.resolve(workspace, file) } : {}) } });
    // 只扫描已存在的技能，不因模型读取而创建目录或示例文件。
    await manager.refresh();
    return manager.getAllSkills();
  }
  async items(actorId: string, conversationId?: string, workspaceId?: string, draft?: ProductSettingsDraft,
    captured?: { workspace?: WorkspaceDefinition; actor?: ActorIdentity }) {
    const actor = captured?.actor ?? this.app.actor(actorId);
    if (!actor) throw new Error('账号不可用。');
    const conversation = conversationId ? captured ? await this.app.storage.getConversation(conversationId) : await this.app.conversation(actorId, conversationId) : undefined;
    const selectedWorkspace = conversation?.workspaceId ?? workspaceId;
    const workspace = captured ? captured.workspace : selectedWorkspace ? this.app.workspace(actorId, String(selectedWorkspace), ['workspace_read']) : undefined;
    const baseConfig = draft?.settings.getSkills() ?? this.app.product.runtimeSettings().getSkills();
    const effective = configs((conversation?.custom as Record<string, unknown> | undefined)?.inputSkills) ?? baseConfig;
    const state = new Map(effective.map(item => [item.id, item]));
    const found = await this.scan(actor, workspace);
    if (actor.role === 'owner') {
      for (const saved of draft?.value.importedSkills ?? this.app.product.importedSkills) {
        if (found.some(skill => skill.id === saved.id)) continue;
        found.push({ ...saved, path: '', basePath: '', source: 'legacy' });
      }
    }
    return found.map(skill => ({ ...skill, enabled: state.get(skill.id)?.enabled ??
      (skill.path ? true : skill.enabled), sendContent: state.get(skill.id)?.sendContent ?? true, exists: true }));
  }
  async list(actorId: string, conversationId?: string, workspaceId?: string, draft?: ProductSettingsDraft) {
    const found = await this.items(actorId, conversationId, workspaceId, draft);
    const conversation = conversationId ? await this.app.storage.getConversation(conversationId) : undefined;
    const saved = configs((conversation?.custom as Record<string, unknown> | undefined)?.inputSkills) ?? draft?.settings.getSkills() ?? this.app.product.runtimeSettings().getSkills();
    return { skills: [
      ...found.map(({ id, name, description, enabled, sendContent, exists, source }) => ({ id, name, description, enabled, sendContent, exists, source })),
      ...saved.filter(item => !found.some(skill => skill.id === item.id)).map(item => ({ ...item, exists: false })),
    ] };
  }
  async change(actorId: string, id: string, enabled: boolean | undefined, conversationId: string | undefined,
    workspaceId: string | undefined, draft: ProductSettingsDraft) {
    const all = (await this.list(actorId, conversationId, workspaceId, draft)).skills;
    const target = all.find(item => item.id === id);
    if (!target && enabled !== undefined) throw new Error('技能不存在，请刷新目录。');
    if (conversationId) {
      // 只更新输入配置；运行中的历史和已捕获提示词保持原样。
      const active = (await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 }))[0];
      const state = await this.app.storage.readConversationState(conversationId);
      const values = all.filter(item => enabled !== undefined || item.id !== id).map(item => ({ id: item.id, name: item.name,
        description: item.description, enabled: item.id === id ? enabled! : item.enabled, sendContent: item.sendContent }));
      const metadata = { ...state.metadata, custom: { ...(state.metadata.custom as Record<string, unknown> ?? {}), inputSkills: values } };
      await this.app.storage.commitConversation({ conversationId, expectedRevision: state.history.revision,
        expectedMetadataToken: state.metadataToken, metadata, ...(active ? { activeRunId: active.id } : {}) });
      this.app.productUi.conversations.clearMetadataCache();
    } else if (enabled === undefined) await draft.settings.removeSkillConfig(id);
    else await draft.settings.setSkillEnabled(id, enabled, target);
    return { success: true };
  }
  tool(): RuntimeTool {
    const legacy = createSkillReadRuntime(() => null).generateReadSkillDeclaration();
    const declaration: ToolDeclaration = { ...legacy, description:
      '按名称读取当前任务可用技能的完整正文。name 为空字符串时列出可用技能名称和说明；匹配任务时按需读取。技能范围由当前工作区、账号和对话配置决定。',
      parameters: { ...legacy.parameters, properties: { name: { type: 'string', description: '技能名称；空字符串表示列出当前可用技能。' } } } };
    return { declaration, effects: () => ['workspace_read'], execute: async (args, context) => {
      const skills = await this.items(context.actorId, context.conversationId, context.workspace?.id, undefined, { workspace: context.workspace, actor: context.actor });
      if (args.name === '') return { success: true, data: { skills: skills.filter(skill => skill.enabled)
        .map(({ name, description }) => ({ name, description })) } };
      const selected = skills.find(skill => skill.name === args.name && skill.enabled);
      const imported = selected && !selected.path ? this.app.product.importedSkills.find(skill => skill.id === selected.id) : undefined;
      if (selected && imported?.bundleId) {
        selected.basePath = await this.bundles.materialize(imported.bundleId);
        selected.path = path.join(selected.basePath, 'SKILL.md');
      }
      const reader = createSkillReadRuntime(() => ({
        getSkillByName: name => skills.find(skill => skill.name === name),
        getSkillSummaries: () => skills.filter(skill => skill.enabled).map(({ name, description }) => ({ name, description })),
        getEnabledSkills: () => skills.filter(skill => skill.enabled),
      }));
      return reader.getReadSkillTool().handler(args);
    } };
  }
  async export(draft: ProductSettingsDraft, userOnly = false): Promise<PlatformSkillExport[]> {
    const result = new Map<string, PlatformSkillExport>();
    const owner = draft.app.accounts.find(actor => actor.role === 'owner' && !actor.revoked);
    if (!owner) throw new Error('主人账号不可用。');
    // 按工作区顺序保留同名技能的首个定义，与原扫描优先级一致。
    for (const workspaceId of [...(userOnly ? [] : draft.app.workspaces.map(workspace => workspace.id)), undefined]) {
      for (const skill of await this.items(owner.id, undefined, workspaceId, draft)) if (!result.has(skill.id) &&
        (workspaceId === undefined || skill.source.startsWith('project-'))) {
        const saved = draft.value.importedSkills?.find(item => item.id === skill.id);
        const resources = skill.path ? await collectSkillBundle(skill.basePath) : saved?.bundleId
          ? draft.value.pendingSkillBundles?.[saved.bundleId] ?? await this.bundles.read(saved.bundleId) : undefined;
        result.set(skill.id, { id: skill.id, name: skill.name, description: skill.description, content: skill.content,
          enabled: skill.enabled, source: skill.source, ...(resources ? { resources } : {}) });
      }
    }
    return [...result.values()];
  }
  stageImport(draft: ProductSettingsDraft, input: unknown): SavedPlatformSkill {
    const skill = this.validateImport(input);
    const resources = (input as PlatformSkillExport).resources;
    if (resources !== undefined) {
      const bundle = validateSkillBundle(resources);
      skill.bundleId = skillBundleId(bundle);
      draft.value.pendingSkillBundles ??= {};
      draft.value.pendingSkillBundles[skill.bundleId] = bundle;
    }
    return skill;
  }
  validateImport(value: unknown): SavedPlatformSkill {
    const skill = value as SkillExportData;
    if (!skill || !SkillsRuntime.validateSkillId(skill.id) || skill.name !== skill.id || typeof skill.description !== 'string' ||
      !skill.description.trim() || typeof skill.content !== 'string') throw new Error('技能名称、说明或正文格式不完整。');
    return { id: skill.id, name: skill.name, description: skill.description, content: skill.content,
      source: typeof skill.source === 'string' ? skill.source : 'legacy', enabled: skill.enabled !== false };
  }
}
