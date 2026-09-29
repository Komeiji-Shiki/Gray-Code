/** 等待动作已应用的回执，不等待动画播放结束；超时也不能宣称动作未执行。 */
export class PetRequests {
  private readonly pending = new Map<string, (error?: Error) => void>();

  wait(id: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('桌宠请求已取消。'));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('桌宠请求已取消。'));
      const timer = setTimeout(() => finish(new Error('播放器未及时确认，实际结果未知，请重试或查看预览。')), 5000);
      this.pending.set(id, finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  settle(id: string, error?: Error): void { this.pending.get(id)?.(error); }
  rejectAll(error: Error): void { for (const finish of this.pending.values()) finish(error); }
}
