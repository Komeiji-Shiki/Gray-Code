/** 共用同批规则，避免单文件工具被误读成每轮只能调用一次。 */
export function toolBatchingGuidance(language: 'zh-CN' | 'en'): string {
  return language === 'zh-CN'
    ? '\n\n独立操作可在同一回复内多次调用本工具或混用其他工具，已确定的多文件修改一起提交；仅结果依赖、修改重叠或需要先确认结果时分轮。'
    : '\n\nSend independent calls and decided edits to multiple files together, repeating or mixing tools as needed. Split only for result dependencies, overlapping edits, or required checks.';
}
