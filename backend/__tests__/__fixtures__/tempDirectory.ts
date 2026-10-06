/**
 * 测试共享 fixture：删除测试创建的临时目录时使用的选项。
 *
 * Windows 上杀毒软件会在文件写入或关闭后短暂打开、复制它们，递归删除会偶发 EBUSY / ENOTEMPTY，
 * 目录稍后即可删除。统一使用 Node 内置的重试参数，禁止在测试内各写一份。
 */
export const TEMP_DIR_REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
