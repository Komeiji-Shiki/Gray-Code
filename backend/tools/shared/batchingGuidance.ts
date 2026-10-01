/** 共用同批规则，避免单文件工具被误读成每轮只能调用一次。 */
export function toolBatchingGuidance(language: 'zh-CN' | 'en'): string {
  return language === 'zh-CN'
    ? '\n\n互不依赖的操作请在同一轮回复里一起发出：可以多次调用同一个工具，也可以混用不同工具，已经确定的多文件修改也一起提交。只有后一步依赖前一步的结果、两步修改同一位置，或需要先确认结果时，才分轮执行。'
    : '\n\nSend independent operations together in the same reply: you can call the same tool several times or mix different tools, and already-decided edits to multiple files should go out together. Split them across turns only when a later step depends on an earlier result, two steps touch the same location, or you need to check a result first.';
}
