/** 上下文范围按条数或目录层级计量；-1 表示使用无限制选项，0 保留原有零范围语义。 */
export function isValidContextLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1;
}
