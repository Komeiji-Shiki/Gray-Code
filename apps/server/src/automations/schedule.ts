import { CronExpressionParser } from 'cron-parser';
import type { AutomationSchedule } from '@graycode/contracts';

export function validateSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (!schedule || typeof schedule !== 'object') throw new Error('请配置触发时间。');
  if (schedule.type === 'once') {
    if (!Number.isSafeInteger(schedule.at) || schedule.at <= 0) throw new Error('触发时间无效。');
    return { type: 'once', at: schedule.at };
  }
  if (schedule.type === 'interval') {
    if (!Number.isSafeInteger(schedule.everyMinutes) || schedule.everyMinutes < 1) throw new Error('执行间隔至少为 1 分钟。');
    if (!Number.isSafeInteger(schedule.startAt) || schedule.startAt <= 0) throw new Error('首次执行时间无效。');
    return { type: 'interval', everyMinutes: schedule.everyMinutes, startAt: schedule.startAt };
  }
  if (schedule.type !== 'daily' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('请使用有效的小时和分钟。');
  if (typeof schedule.timeZone !== 'string' || !schedule.timeZone.trim()) throw new Error('请选择执行时区。');
  try { new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format(); } catch { throw new Error('时区无效。'); }
  const weekDays = schedule.weekDays && [...new Set(schedule.weekDays)].sort();
  if (weekDays && (!weekDays.length || weekDays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('请至少选择一周中的一天。');
  return { type: 'daily', time: schedule.time, timeZone: schedule.timeZone, ...(weekDays ? { weekDays } : {}) };
}

/** 返回严格晚于指定时刻的下一次触发；日历任务按所选时区处理夏令时。 */
export function nextScheduledTime(schedule: AutomationSchedule, after: number): number | undefined {
  if (schedule.type === 'once') return schedule.at > after ? schedule.at : undefined;
  if (schedule.type === 'interval') {
    const interval = schedule.everyMinutes * 60_000;
    return schedule.startAt + Math.max(0, Math.floor((after - schedule.startAt) / interval) + 1) * interval;
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  return CronExpressionParser.parse(`${minute} ${hour} * * ${schedule.weekDays?.join(',') ?? '*'}`, { currentDate: after, tz: schedule.timeZone }).next().getTime();
}
