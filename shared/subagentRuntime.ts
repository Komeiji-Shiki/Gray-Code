/** 单次派发的时长只允许覆盖通用 Worker，不修改保存的默认值。 */
export function resolveSubagentMaxRuntime(general: boolean, override: unknown, fallbackSeconds: number): number {
  if (override === undefined) return fallbackSeconds;
  if (!general) throw new Error('maxRuntime 只适用于 General Worker；自定义代理使用其配置的运行时间。');
  if (!Number.isSafeInteger(override) || (override !== -1 && (override as number) < 1)) {
    throw new Error('maxRuntime 必须为正整数秒数，或 -1 表示无限制。');
  }
  return override as number;
}
