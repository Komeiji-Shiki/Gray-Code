/** 共用同批规则，避免单文件工具被误读成每轮只能调用一次。 */
export function toolBatchingGuidance(language: 'zh-CN' | 'en'): string {
  return language === 'zh-CN'
    ? '\n\n同批调用：互不依赖的操作应在同一轮一次提交，可以重复调用相同工具，也可以混合不同工具。已明确的多文件修改一起提交，不要每改一个文件就停下等下一轮。例如，可把独立的读取与搜索放在同一批，也可把不同文件的修改与新建放在同一批。只有后续操作依赖前一步结果、修改同一位置或需要先确认结果时才分步执行。'
    : '\n\nBatch independent operations in the same reply, using repeated calls to one tool or calls to different tools. Submit all already-specified independent file edits together instead of stopping after each file. For example, read_file(A) with search_in_files(B), or apply_diff(A) with write_file(B), can share one batch. Split operations only when later steps depend on earlier results, modify overlapping state, or require checking an earlier result first.';
}
