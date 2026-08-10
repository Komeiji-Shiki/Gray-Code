/**
 * 文件名 slug 生成（从 design/plan/progress/review 各 create 工具收敛而来）
 *
 * 各调用方原始实现逻辑一致（小写、空白/下划线转连字符、去除非安全字符、压缩连字符），
 * 仅「空结果时的兜底值」不同，通过 fallback 参数保留各家原有行为。
 */

export function slugify(input: string, fallback: string = ''): string {
  const s = (input || '').trim().toLowerCase();
  const slug = s
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}
