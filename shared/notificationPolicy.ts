/** 声音、系统通知与陪伴提示共用规则，不改变任务执行或审批状态。 */
export interface NotificationQuietHours {
  mode: 'off' | 'always' | 'schedule';
  start?: string;
  end?: string;
  timeZone?: string;
}

export function validateNotificationQuietHours(value: NotificationQuietHours): NotificationQuietHours {
  if (!value || !['off', 'always', 'schedule'].includes(value.mode)) throw new Error('请选择免打扰方式。');
  if (value.mode === 'schedule') {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!time.test(value.start ?? '') || !time.test(value.end ?? '')) throw new Error('请填写免打扰开始和结束时间。');
    if (value.start === value.end) throw new Error('开始和结束时间不能相同，全天免打扰请选择“持续免打扰”。');
    if (!value.timeZone?.trim()) throw new Error('请填写免打扰时区。');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); }
    catch { throw new Error('免打扰时区无效，请填写例如 Asia/Shanghai 的时区名称。'); }
  }
  return { mode: value.mode, ...(typeof value.start === 'string' ? { start: value.start } : {}),
    ...(typeof value.end === 'string' ? { end: value.end } : {}), ...(typeof value.timeZone === 'string' ? { timeZone: value.timeZone.trim() } : {}) };
}

export function isNotificationQuiet(value?: NotificationQuietHours | null, now = Date.now()): boolean {
  if (!value || value.mode === 'off') return false;
  if (value.mode === 'always') return true;
  if (value.mode !== 'schedule') return false;
  try {
    validateNotificationQuietHours(value);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: value.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const clock = `${parts.find(part => part.type === 'hour')!.value}:${parts.find(part => part.type === 'minute')!.value}`;
    return value.start! < value.end! ? clock >= value.start! && clock < value.end! : clock >= value.start! || clock < value.end!;
  } catch {
    // 已选择定时免打扰但导入配置无效时保持安静，由设置页显示并修正。
    return true;
  }
}
