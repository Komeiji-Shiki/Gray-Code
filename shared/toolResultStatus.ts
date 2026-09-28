/** 工具回执中的混合结果，不把部分完成误判为整批失败。 */
export function isPartialToolData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.partial === true || data.status === 'partial') return true;
  const positive = (count: unknown) => typeof count === 'number' && Number.isFinite(count) && count > 0;
  if (positive(data.appliedCount) && positive(data.failedCount)) return true;
  if (positive(data.successCount) && positive(data.failCount)) return true;
  if (!Array.isArray(data.results)) return false;
  return data.results.some(item => item?.success === true) && data.results.some(item => item?.success === false);
}
