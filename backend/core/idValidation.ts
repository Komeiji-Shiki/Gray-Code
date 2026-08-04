/**
 * 安全标识符校验
 *
 * 所有会进入文件系统路径的标识符（conversationId、checkpointId、diffId 等）
 * 必须在进入 path.join / fs 操作前经过本模块校验，避免 `..`、绝对路径、
 * 盘符等写法造成的路径穿越。
 *
 * 生成侧约定（ConversationManager / CheckpointManager / DiffStorageManager）
 * 产出的 ID 均满足 `[A-Za-z0-9_-]{1,128}`，此处校验不会误伤正常数据。
 */

export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

/**
 * 校验并返回安全 ID；非法时抛出错误（由调用方转为用户可见错误信息）。
 */
export function assertSafeId(value: unknown, name: string): string {
  if (!isSafeId(value)) {
    throw new Error(`Invalid ${name}: must match [A-Za-z0-9_-]{1,128}`);
  }
  return value;
}

/**
 * 校验一个“相对路径”是否安全：
 * - 非空
 * - 非绝对路径（不以 / 或盘符开头）
 * - 不包含 `..` 路径段
 * - 不包含空段/`.` 段（路径本身由调用方生成时，正常相对路径不会出现）
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every(seg => seg !== '..' && seg !== '.' && seg !== '');
}

/**
 * 校验并返回安全的相对路径；非法时抛出错误。
 */
export function assertSafeRelativePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isSafeRelativePath(value)) {
    throw new Error(`Invalid ${name}: unsafe relative path`);
  }
  return value;
}
