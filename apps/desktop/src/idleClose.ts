/** 合并后台事件的存储查询；查询期间有新事件时，只补读最新状态一次。 */
export function createIdleCloseCheck(options: { pending(): boolean; active(): Promise<boolean>; close(): Promise<void>; report(error: unknown): void }) {
  let running = false;
  let requested = false;
  const check = () => {
    if (!options.pending()) return;
    requested = true;
    if (running) return;
    running = true;
    void (async () => {
      while (requested && options.pending()) {
        requested = false;
        const active = await options.active();
        // 旧查询期间发生过状态变化时，不能根据旧快照退出。
        if (!requested && !active && options.pending()) await options.close();
      }
    })().catch(options.report).finally(() => {
      running = false;
      if (requested && options.pending()) check();
    });
  };
  return check;
}
