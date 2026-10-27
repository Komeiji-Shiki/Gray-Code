import Database from 'better-sqlite3';

/**
 * 数据目录的唯一所有权：独立锁库上的 EXCLUSIVE 事务从不提交，持有到连接关闭；进程退出（含崩溃）时由系统释放。
 * 对象回收只允许一个存储服务执行，所以仍需要独占；放在锁库上是为了让主库保持普通锁模式，
 * 应用运行期间外部工具（调试、备份检查）可以只读打开它。第二个所有者在超时后收到 SQLITE_BUSY。
 */
export function acquireOwnership(databasePath: string): Database.Database {
  const owner = new Database(`${databasePath}.owner`, { timeout: 1000 });
  try { owner.exec('BEGIN EXCLUSIVE'); }
  catch (error) { owner.close(); throw error; }
  return owner;
}
