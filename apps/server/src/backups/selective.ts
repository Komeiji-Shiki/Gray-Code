import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PlatformStorage } from '@graycode/core';
import type { BackupRestoreSelectionPlan } from '@graycode/contracts';
import { captureDirectory } from '../migration/directoryCapture';
import { deviceFingerprint, directoryFingerprint, skillDirectories } from './catalog';
import { validateBackupResources } from './resources';

const exists = async (directory: string) => fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
export async function buildSelectiveRestore(currentDirectory: string, importedDirectory: string, stagingDirectory: string, selection: BackupRestoreSelectionPlan) {
  const current = await PlatformStorage.open(currentDirectory);
  let snapshot: string | undefined;
  const signal = new AbortController().signal;
  try {
    if (selection.expectedDevices && deviceFingerprint(await current.backupInventory()) !== selection.expectedDevices) throw new Error('设备配置在最终预览后发生了变化，请重新预览。');
    for (const directory of selection.directories) {
      if (!skillDirectories.includes(directory.name)) throw new Error('技能恢复目录无效。');
      if (await directoryFingerprint(path.join(importedDirectory, directory.name)) !== directory.source) throw new Error('备份中的技能目录已经变化，请重新校验备份。');
      if (directory.conflict === 'replace' && await directoryFingerprint(path.join(currentDirectory, directory.name)) !== directory.expected) throw new Error('技能目录在最终预览后发生了变化，请重新预览。');
    }
    const captured = await current.backupSnapshot(); snapshot = captured.directory;
    for (const name of ['bot-documents', ...skillDirectories]) if (await exists(path.join(currentDirectory, name)))
      await captureDirectory(path.join(currentDirectory, name), path.join(snapshot, name), signal);
  } catch (error) {
    if (snapshot) await fs.rm(snapshot, { recursive: true, force: true }); throw error;
  } finally { await current.close(); }
  if (!snapshot) throw new Error('无法准备当前数据的恢复副本。');
  await fs.rename(snapshot, stagingDirectory);
  const merged = await PlatformStorage.open(stagingDirectory);
  try {
    const result = await merged.mergeBackupUnits({ sourceDirectory: importedDirectory, groups: selection.groups });
    for (const key of result.restored) {
      const [kind, , id] = JSON.parse(key) as string[];
      if (kind !== 'conversation') continue;
      const name = createHash('sha256').update(id).digest('hex');
      const target = path.join(stagingDirectory, 'bot-documents', name), source = path.join(importedDirectory, 'bot-documents', name);
      // 这些路径只来自固定目录名与散列，删除不会越出本次准备的副本。
      await fs.rm(target, { recursive: true, force: true });
      if (await exists(source)) await captureDirectory(source, target, signal);
    }
    for (const directory of selection.directories) {
      const target = path.join(stagingDirectory, directory.name), source = path.join(importedDirectory, directory.name);
      if (directory.conflict === 'keep' && await exists(target)) continue;
      await fs.rm(target, { recursive: true, force: true }); await captureDirectory(source, target, signal);
    }
    await validateBackupResources(merged);
    const checked = await merged.verify(); if (!checked.ok) throw new Error(`选择性恢复未通过校验：${checked.issues.slice(0, 3).join('；')}`);
    await merged.checkpoint();
    return { ...result, statistics: await merged.statistics() };
  } finally { await merged.close(); }
}
