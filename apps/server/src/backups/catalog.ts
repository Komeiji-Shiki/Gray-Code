import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { PlatformStorage } from '@graycode/core';
import type { BackupCategoryId, BackupMergeGroup, BackupRestorePreview, BackupRestoreSelection, BackupRestoreSelectionPlan, BackupUnit } from '@graycode/contracts';

export const backupCategories: Array<{ id: BackupCategoryId; name: string; description: string }> = [
  { id: 'conversations', name: '对话与任务', description: '完整会话、附件、分支、检查点、角色配置和关联自动任务。相同会话作为一个整体处理。' },
  { id: 'settings', name: '设置与连接凭据', description: '账号权限、工作区配置、模型渠道、预设和连接凭据。项目源码不在恢复范围内。' },
  { id: 'memories', name: '长期记忆', description: '按账号和范围恢复事实、来源、修订、摘要与检索数据，保留当前删除记录。' },
  { id: 'devices', name: '执行设备', description: '设备身份和配对作为一个整体恢复。替换会移除当前配对配置；恢复后需手动启用，已撤销设备继续保持撤销。' },
  { id: 'pets', name: '桌宠与 Live2D', description: '模型、图集、动作、悬浮设置，以及备份中已有的本地 Core。资源按模型整体处理。' },
  { id: 'screen', name: '屏幕感知设置', description: '单独恢复采集配置与发送记录。恢复后不会自动采集，原窗口可能需要重新选择。' },
  { id: 'skills', name: '本地技能', description: '技能配置与文件目录；同一技能目录中的冲突按整目录处理。' },
  { id: 'other', name: '其他程序记录', description: '使用情况、电脑操作记录与其他资源，按记录所属类别保留。' },
];
export const skillDirectories = ['skills', 'user-skills', 'skill-resources'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nodeUnit = (unit: BackupUnit) => unit.kind === 'record' && (unit.namespace === 'execution-node' || unit.namespace!.startsWith('node-'));
export const deviceFingerprint = (units: BackupUnit[]) => digest(units.filter(nodeUnit).map(unit => [unit.key, unit.fingerprint]));
export async function directoryFingerprint(directory: string): Promise<string | null> {
  try { if (!(await fs.lstat(directory)).isDirectory()) throw new Error('资源目录无效。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const files: Array<[string, string]> = [];
  const visit = async (relative: string) => {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('技能备份不跟随符号链接。');
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) { files.push([file.replaceAll('\\', '/') + '/', 'directory']); await visit(file); }
      else { const hash = createHash('sha256'); for await (const chunk of createReadStream(path.join(directory, file))) hash.update(chunk); files.push([file.replaceAll('\\', '/'), hash.digest('hex')]); }
    }
  };
  await visit(''); return digest(files);
}
interface Item { id: string; name: string; category: BackupCategoryId; units: BackupUnit[]; requires: string[] }
export interface RestoreCatalog { preview: BackupRestorePreview; items: Item[]; current: BackupUnit[]; directories: Array<{ name: string; source: string; expected: string | null }> }

export async function restoreCatalog(source: PlatformStorage, current: PlatformStorage, migrations: string[] = [], unavailableCredentials: string[] = []): Promise<RestoreCatalog> {
  const [units, currentUnits] = await Promise.all([source.backupInventory(), current.backupInventory()]);
  const settings = await source.getRecord('platform-settings', 'main') as { accounts?: Array<{ id: string; displayName: string }>; workspaces?: Array<{ name: string; directory: string }> } | null;
  const items: Item[] = [], used = new Set<string>();
  const add = (id: string, name: string, category: BackupCategoryId, candidates: BackupUnit[]) => {
    const selected = candidates.filter(unit => !used.has(unit.key)); if (!selected.length) return;
    selected.forEach(unit => used.add(unit.key)); items.push({ id, name, category, units: selected, requires: [] });
  };
  for (const unit of units.filter(unit => unit.kind !== 'record')) {
    const account = settings?.accounts?.find(account => account.id === unit.actorId)?.displayName ?? unit.actorId ?? '原账号';
    const workspace = unit.scopeKey && settings?.workspaces?.find(workspace => workspace.directory.replaceAll('\\', '/').toLowerCase() === unit.scopeKey!.replaceAll('\\', '/').toLowerCase())?.name;
    const scope = unit.scopeKind === 'personal' ? '个人记忆' : unit.scopeKind === 'group' ? '群组记忆' : unit.scopeKind === 'workspace' ? '项目记忆' : '原格式记忆';
    const name = unit.kind === 'conversation' ? unit.label : `${account} · ${scope}${workspace ? ' · ' + workspace : ''}${unit.realm && unit.realm !== 'real' ? ' · 角色剧情' : ''}`;
    add(unit.key, name, unit.kind === 'conversation' ? 'conversations' : 'memories', [unit]);
  }
  const records = units.filter(unit => unit.kind === 'record');
  for (const unit of records.filter(unit => unit.namespace === 'pet-resource')) {
    const info = await source.getRecord(unit.namespace!, unit.id) as { name: string };
    add(`pet:${unit.id}`, info.name, 'pets', records.filter(row => row.key === unit.key || row.namespace === 'pet-resource-file' && row.id.startsWith(unit.id + '/')));
  }
  add('pet-runtime', '本地 Live2D Core', 'pets', records.filter(unit => unit.namespace === 'pet-runtime'));
  add('pet-settings', '桌宠显示与动画设置', 'pets', records.filter(unit => ['pet-configuration', 'pet-position'].includes(unit.namespace!)));
  add('devices', '设备身份与配对', 'devices', records.filter(nodeUnit));
  add('settings', '账号、渠道与功能设置', 'settings', records.filter(unit => ['platform-settings', 'product-settings'].includes(unit.namespace!)));
  add('screen', '屏幕感知配置与记录', 'screen', records.filter(unit => unit.namespace!.startsWith('screen-sense-')));
  add('memory-settings', '记忆策略与原格式设置', 'memories', records.filter(unit => ['memory-config', 'long-memory-policy'].includes(unit.namespace!)));
  for (const namespace of new Set(records.filter(unit => !used.has(unit.key) && unit.namespace !== 'platform-secrets').map(unit => unit.namespace!)))
    add(`records:${namespace}`, namespace.startsWith('skill') || namespace === 'imported-skills' ? '技能配置：' + namespace : namespace, /skill/.test(namespace) ? 'skills' : 'other', records.filter(unit => unit.namespace === namespace));
  for (const unit of records.filter(unit => unit.namespace === 'platform-secrets')) add(`secret:${unit.id}`, '连接凭据 ' + unit.id, 'settings', [unit]);
  const secretIds = new Set(records.filter(unit => unit.namespace === 'platform-secrets').map(unit => unit.id));
  const referenced = (value: unknown, found: Set<string>) => {
    if (typeof value === 'string' && secretIds.has(value)) found.add(`secret:${value}`);
    else if (Array.isArray(value)) value.forEach(item => referenced(item, found));
    else if (value && typeof value === 'object' && !(value instanceof Uint8Array)) Object.values(value).forEach(item => referenced(item, found));
  };
  for (const item of items) {
    if (item.id.startsWith('secret:') || item.units[0].kind !== 'record') continue;
    const dependencies = new Set<string>();
    for (const unit of item.units) {
      if (['pet-resource-file', 'pet-runtime', 'computer-actions', 'activity-samples'].includes(unit.namespace!)) continue;
      const value = await source.getRecord(unit.namespace!, unit.id) as Record<string, any>; referenced(value, dependencies);
      if (value?.conversationId) { const conversation = units.find(row => row.kind === 'conversation' && row.id === value.conversationId); if (conversation && !currentUnits.some(row => row.key === conversation.key)) dependencies.add(conversation.key); }
      if (unit.namespace === 'pet-configuration' && value?.resourceId && !currentUnits.some(row => row.namespace === 'pet-resource' && row.id === value.resourceId)) dependencies.add(`pet:${value.resourceId}`);
    }
    item.requires = [...dependencies];
  }
  const directories = (await Promise.all(skillDirectories.map(async name => {
    const [sourceHash, expected] = await Promise.all([directoryFingerprint(path.join(source.directory, name)), directoryFingerprint(path.join(current.directory, name))]);
    return sourceHash ? { name, source: sourceHash, expected } : null;
  }))).filter((item): item is NonNullable<typeof item> => !!item);
  const categories = backupCategories.map(category => {
    const own = items.filter(item => item.category === category.id);
    const conflicts = own.filter(item => item.units.some(unit => currentUnits.some(value => value.key === unit.key)));
    const dependencies = new Map<BackupCategoryId, string>();
    for (const item of own) for (const id of item.requires) { const required = items.find(value => value.id === id); if (required && required.category !== category.id) dependencies.set(required.category, `包含所依赖的${backupCategories.find(value => value.id === required.category)!.name}对象，准备恢复时会列出实际范围。`); }
    return { ...category, count: own.length + (category.id === 'skills' ? directories.length : 0), conflicts: conflicts.length + (category.id === 'skills' ? directories.filter(item => item.expected).length : 0),
      dependencies: [...dependencies].map(([id, reason]) => ({ id, reason })), examples: own.slice(0, 20).map(item => ({ name: item.name, conflict: conflicts.includes(item) })) };
  });
  return { items, current: currentUnits, directories, preview: { fingerprint: digest({ source: units.map(unit => [unit.key, unit.fingerprint]), directories: directories.map(item => [item.name, item.source]) }), createdAt: Date.now(), categories, migrations, unavailableCredentials } };
}

export function selectBackupRestore(catalog: RestoreCatalog, selection: BackupRestoreSelection): BackupRestoreSelectionPlan {
  if (!['complete', 'selective'].includes(selection.mode) || selection.expectedPreview !== catalog.preview.fingerprint) throw new Error('数据在预览后发生了变化，请刷新恢复预览。');
  if (selection.mode === 'complete') {
    if (catalog.preview.unavailableCredentials?.length) throw new Error('完整恢复需要解密所有连接凭据。请在仍能解密凭据的原应用中使用备份密码重新导出，或只恢复不依赖这些凭据的类别。');
    return { ...selection, groups: [], directories: [] };
  }
  if (!selection.categories?.length || new Set(selection.categories.map(category => category.id)).size !== selection.categories.length) throw new Error('请至少选择一个恢复类别，并指定冲突处理方式。');
  const selected = new Map<string, 'keep' | 'replace'>();
  const add = (id: string, conflict: 'keep' | 'replace') => {
    const item = catalog.items.find(item => item.id === id); if (!item) throw new Error('备份缺少所选资源的依赖。');
    const previous = selected.get(id); if (previous && previous !== conflict) throw new Error('关联资源的冲突处理方式不一致，请为相关类别选择相同方式。');
    if (previous) return; selected.set(id, conflict);
    // 保留已有整体时不替换它的凭据或关联资源。
    if (conflict === 'keep' && item.units.some(unit => catalog.current.some(value => value.key === unit.key))) return;
    item.requires.forEach(required => add(required, conflict));
  };
  for (const category of selection.categories) {
    if (!catalog.preview.categories.some(value => value.id === category.id && value.count) || !['keep', 'replace'].includes(category.conflict)) throw new Error('恢复类别或冲突处理方式无效。');
    catalog.items.filter(item => item.category === category.id).forEach(item => add(item.id, category.conflict));
  }
  const groups: BackupMergeGroup[] = [...selected].map(([id, conflict]) => {
    const item = catalog.items.find(item => item.id === id)!;
    const copying = conflict === 'replace' || !item.units.some(unit => catalog.current.some(row => row.key === unit.key));
    if (copying && item.units.some(unit => unit.namespace === 'platform-secrets' && catalog.preview.unavailableCredentials?.includes(unit.id))) throw new Error('所选类别依赖原电脑或原应用配置保护的连接凭据，请在仍能解密凭据的原应用中使用备份密码重新导出，或取消这个类别。');
    const remove = id === 'devices' && conflict === 'replace' ? catalog.current.filter(unit => nodeUnit(unit) && unit.namespace !== 'node-revocations' && !item.units.some(source => source.key === unit.key)) : [];
    return { id, conflict, units: item.units, remove, source: Object.fromEntries(item.units.map(unit => [unit.key, unit.fingerprint])),
      expected: Object.fromEntries([...item.units, ...remove].map(unit => [unit.key, catalog.current.find(value => value.key === unit.key)?.fingerprint ?? null])) };
  });
  const skills = selection.categories.find(category => category.id === 'skills');
  return { ...selection, groups, directories: skills ? catalog.directories.map(directory => ({ ...directory, conflict: skills.conflict })) : [],
    items: [...selected].map(([id, conflict]) => { const item = catalog.items.find(item => item.id === id)!; return { name: item.name, category: item.category,
      action: conflict === 'keep' && item.units.some(unit => catalog.current.some(row => row.key === unit.key)) ? 'keep' as const : 'restore' as const,
      dependency: !selection.categories!.some(category => category.id === item.category) }; }),
    ...(selection.categories.some(category => category.id === 'devices' && category.conflict === 'replace') ? { expectedDevices: deviceFingerprint(catalog.current) } : {}) };
}
