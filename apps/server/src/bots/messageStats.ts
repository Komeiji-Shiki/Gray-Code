import type { PlatformMessage } from '@graycode/contracts';
import { calculateTokenRate } from '../../../../shared/tokenRate';

export function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
const seconds = (value: unknown) => milliseconds(value) === undefined ? '—' : `${(Number(value) / 1000).toFixed(2)}s`;
export function thinkingComplete(duration: unknown): string {
  return milliseconds(duration) === undefined ? '思考完成' : `已进行思考 ${(Number(duration) / 1000).toFixed(1)} 秒`;
}

/** 只使用已保存的本次模型回复统计，不把文字长度当作 token 数。 */
export function botStatsFooter(message: PlatformMessage): string {
  const usage = message.usageMetadata as BotUsage | undefined;
  const duration = milliseconds(message.responseDuration) ?? milliseconds(message.streamDuration);
  const rate = message.usageMetadataPartial ? undefined : calculateTokenRate({ chunkCount: milliseconds(message.chunkCount),
    ttft: milliseconds(message.ttft), responseDuration: duration, usageMetadata: usage });
  const items = [`TTFT ${seconds(message.ttft)}`, `耗时 ${seconds(duration)}`, `TPS ${rate !== undefined && Number.isFinite(rate) ? rate.toFixed(1) : '—'}`];
  if (usage) {
    if (milliseconds(usage.promptTokenCount) !== undefined) items.push(`输入 ${usage.promptTokenCount}`);
    if (milliseconds(usage.candidatesTokenCount) !== undefined) items.push(`输出 ${usage.candidatesTokenCount}`);
    const cache = milliseconds(usage.cacheReadTokenCount) ?? milliseconds(usage.cachedContentTokenCount);
    if (cache !== undefined) items.push(`缓存 ${cache}`);
  }
  return `-# ${items.join(' · ')}`;
}

interface BotUsage {
  promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number;
  cachedContentTokenCount?: number; cacheReadTokenCount?: number; cacheCreationTokenCount?: number;
}
function counts(message: PlatformMessage) {
  const usage = message.usageMetadata as BotUsage | undefined;
  const input = milliseconds(usage?.promptTokenCount); const output = milliseconds(usage?.candidatesTokenCount);
  return { input, output, cache: milliseconds(usage?.cacheReadTokenCount) ?? milliseconds(usage?.cachedContentTokenCount),
    creation: milliseconds(usage?.cacheCreationTokenCount),
    // 优先采用供应方总数；缓存是输入的一部分，思考也不能无条件再加到输出上。
    total: milliseconds(usage?.totalTokenCount) ?? (input !== undefined && output !== undefined ? input + output : undefined) };
}
export function botRoundStats(message: PlatformMessage, iteration: number, toolNames: string[]): string {
  const value = counts(message);
  const tools = toolNames.length ? ` · 调用${toolNames.map(name => `「${name.replace(/[\r\n]/g, ' ')}」`).join('、')}` : '';
  const stats = botStatsFooter(message).slice(3);
  const missing = [value.input === undefined ? '输入 —' : '', value.output === undefined ? '输出 —' : '', value.cache === undefined ? '缓存 —' : ''].filter(Boolean);
  return `-# 第 ${iteration} 轮${tools} · ${[stats, ...missing, ...(value.creation !== undefined ? [`缓存写入 ${value.creation}`] : []),
    ...(message.usageMetadataPartial ? ['统计不完整'] : [])].join(' · ')}`;
}
export function botTotalStats(messages: PlatformMessage[]): string {
  const values = messages.map(counts);
  let incomplete = false;
  const sum = (field: keyof ReturnType<typeof counts>) => {
    const known = values.map(value => value[field]).filter((value): value is number => value !== undefined);
    const partial = known.length !== values.length || messages.some(message => message.usageMetadataPartial);
    if (partial) incomplete = true;
    return known.length ? `${partial ? '≥ ' : ''}${known.reduce((total, value) => total + value, 0)}` : '—';
  };
  const tokens = [`合计 ${sum('total')} token`, `输入 ${sum('input')}`, `输出 ${sum('output')}`, `缓存 ${sum('cache')}`];
  if (values.some(value => value.creation !== undefined)) tokens.push(`缓存写入 ${sum('creation')}`);
  const durations = messages.map(message => milliseconds(message.responseDuration) ?? milliseconds(message.streamDuration));
  const duration = durations.every(value => value !== undefined) ? durations.reduce((total, value) => total + value!, 0) : undefined;
  const generation = messages.map(message => {
    const response = milliseconds(message.responseDuration) ?? milliseconds(message.streamDuration);
    const ttft = milliseconds(message.ttft);
    return !message.usageMetadataPartial && Number(message.chunkCount) > 1 && response !== undefined && ttft !== undefined && response > ttft ? response - ttft : undefined;
  });
  const rate = generation.every(value => value !== undefined) && values.every(value => value.output !== undefined)
    ? values.reduce((total, value) => total + value.output!, 0) / (generation.reduce((total, value) => total + value!, 0) / 1000) : undefined;
  return `-# 共 ${messages.length} 轮 · ${tokens.join(' · ')} · 模型耗时 ${seconds(duration)} · TPS ${rate !== undefined && Number.isFinite(rate) ? rate.toFixed(1) : '—'}${incomplete ? ' · 统计不完整' : ''}`;
}
