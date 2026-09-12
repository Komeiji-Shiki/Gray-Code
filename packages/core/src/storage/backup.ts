import * as fs from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './schema';

/** 数据库与外置块由同一个写入线程截取，回收操作不能在两者之间插入。 */
export function captureStorageSnapshot(db: SqliteConnection, databasePath: string, objectPath: string) {
  const directory = fs.mkdtempSync(path.join(path.dirname(databasePath), '.backup-snapshot-'));
  const createdAt = Date.now();
  try {
    db.prepare('VACUUM INTO ?').run(path.join(directory, 'platform.sqlite'));
    const rows = db.prepare('SELECT DISTINCT file_id FROM chunks WHERE file_id IS NOT NULL').all() as { file_id: string }[];
    for (const { file_id: id } of rows) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('备份遇到无效的附件路径。');
      const relative = path.join(id.slice(0, 2), `${id}.bin`);
      const target = path.join(directory, 'objects', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 内容块发布后不再修改，硬链接使后续回收不影响快照，也避免重复复制大附件。
      try { fs.linkSync(path.join(objectPath, relative), target); }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        fs.copyFileSync(path.join(objectPath, relative), target, fs.constants.COPYFILE_EXCL);
      }
    }
    return { directory, createdAt };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
