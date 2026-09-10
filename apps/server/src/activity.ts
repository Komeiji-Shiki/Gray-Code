import type { PlatformStorage } from '@graycode/core';
import { getActivityStats } from '../../../backend/modules/activity/activityStats';
import { toDateStr } from '../../../backend/modules/activity/ActivityStore';
import type { ActivityStatsQuery, DayActivityFile } from '../../../backend/modules/activity/types';
import { ACTIVITY_SAMPLE_DEDUP_MS } from '../../../backend/modules/activity/types';

/** 活动采样进入独立存储，统计继续使用原来的会话、每日和热力算法。 */
export class PlatformActivity {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly sampledAt = new Map<string, number>();
  constructor(private readonly storage: PlatformStorage) {}
  private serialize<T>(actorId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(actorId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(actorId, operation); return operation;
  }
  pulse(actorId: string): Promise<void> {
    return this.serialize(actorId, async () => {
      const now = Date.now();
      if (Math.abs(now - (this.sampledAt.get(actorId) ?? 0)) < ACTIVITY_SAMPLE_DEDUP_MS) return;
      const date = toDateStr(now); const id = `${actorId}_${date}`;
      const record = await this.storage.getVersionedRecord('activity-samples', id);
      const value = record.value as DayActivityFile | null;
      const samples = [...(value?.samples ?? [])];
      // 导入或系统时钟调整后，新的采样不一定晚于已保存的最后一个时间点。
      let lo = 0; let hi = samples.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid] < now) lo = mid + 1; else hi = mid; }
      if ((lo === 0 || now - samples[lo - 1] >= ACTIVITY_SAMPLE_DEDUP_MS) &&
        (lo === samples.length || samples[lo] - now >= ACTIVITY_SAMPLE_DEDUP_MS)) samples.splice(lo, 0, now);
      await this.storage.commitRecords([{ namespace: 'activity-samples', id, ownerId: actorId, expectedRevision: record.revision, value: { date, samples } }]);
      this.sampledAt.set(actorId, now);
    });
  }
  async importDay(actorId: string, day: DayActivityFile, source: { id: string; fingerprint: string; path: string }): Promise<boolean> {
    return this.serialize(actorId, async () => {
      const marker = await this.storage.getVersionedRecord('legacy-activity-files', source.id);
      if ((marker.value as { fingerprint?: string } | null)?.fingerprint === source.fingerprint) return false;
      const id = `${actorId}_${day.date}`;
      const current = await this.storage.getVersionedRecord('activity-samples', id);
      const previous = current.value as DayActivityFile | null;
      const samples = [...new Set([...(previous?.samples ?? []), ...day.samples])].sort((a, b) => a - b);
      await this.storage.commitRecords([
        { namespace: 'activity-samples', id, ownerId: actorId, expectedRevision: current.revision, value: { date: day.date, samples } },
        { namespace: 'legacy-activity-files', id: source.id, ownerId: actorId, expectedRevision: marker.revision,
          value: { ...source, importedAt: Date.now(), date: day.date } },
      ]);
      return true;
    });
  }
  async stats(actorId: string, query: ActivityStatsQuery = {}) {
    await this.queues.get(actorId);
    const loadAllDays = async (now = Date.now()): Promise<DayActivityFile[]> => {
      const days: DayActivityFile[] = [];
      for (const id of await this.storage.listRecords('activity-samples', actorId)) {
        const value = await this.storage.getRecord('activity-samples', id) as DayActivityFile | null;
        if (value) days.push(value);
      }
      const today = toDateStr(now);
      if (!days.some(day => day.date === today)) days.push({ date: today, samples: [] });
      return days.sort((a, b) => a.date.localeCompare(b.date));
    };
    const loadRecentDays = async (count: number, now = Date.now()): Promise<DayActivityFile[]> => {
      const start = new Date(now); start.setDate(start.getDate() - count + 1);
      const from = toDateStr(start.getTime());
      return (await loadAllDays(now)).filter(day => day.date >= from);
    };
    return getActivityStats({ loadAllDays, loadRecentDays }, query);
  }
}
