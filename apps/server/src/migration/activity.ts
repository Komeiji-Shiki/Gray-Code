import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MigrationIssue } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { DayActivityFile } from '../../../../backend/modules/activity/types';

export interface ActivityImportReport { imported: string[]; skipped: string[]; consumed: string[]; issues: MigrationIssue[] }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** 不调用会修复或删除坏文件的旧活动存储器，原采样只读合并进当前主人的记录。 */
export async function importLegacyActivity(app: PlatformApplication, actorId: string, root: string, signal: AbortSignal): Promise<ActivityImportReport> {
  app.requireOwner(actorId);
  const result: ActivityImportReport = { imported: [], skipped: [], consumed: [], issues: [] };
  const directory = path.join(root, 'activity');
  let entries;
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('活动目录是符号链接，未读取外部数据。');
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ path: directory, code: 'IO_ERROR', message: String(error) });
    return result;
  }
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      if (!entry.isFile()) throw new Error('活动采样不是普通文件。');
      const before = await fs.stat(file);
      if (before.size > 16 * 1024 * 1024) throw new Error('单日活动采样文件超过 16 MiB。');
      const bytes = await fs.readFile(file); const after = await fs.stat(file);
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间活动记录发生变化。');
      const day = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as DayActivityFile;
      if (!day || day.date !== entry.name.slice(0, -5) || !Array.isArray(day.samples) ||
        day.samples.some(sample => typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0 || !Number.isFinite(new Date(sample).getTime()))) throw new Error('活动日期或采样格式无效。');
      signal.throwIfAborted();
      const id = hash(`${actorId}\0${process.platform === 'win32' ? root.toLowerCase() : root}\0${entry.name}`);
      const imported = await app.activity.importDay(actorId, day, { id, fingerprint: hash(bytes), path: file });
      (imported ? result.imported : result.skipped).push(day.date); result.consumed.push(file);
    } catch (error) {
      signal.throwIfAborted();
      result.issues.push({ path: file, code: 'CORRUPT_DATA', message: String(error) });
    }
  }
  return result;
}
