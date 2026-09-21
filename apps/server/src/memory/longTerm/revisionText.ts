export interface MemoryTextEdit { text?: string; oldText?: string; newText?: string; append?: string }

/** 精确补丁只接受唯一匹配，避免为了改一句话重写整条记忆。 */
export function revisedMemoryText(previous: string, input: MemoryTextEdit): string {
  const patch = input.oldText !== undefined || input.newText !== undefined;
  const modes = Number(input.text !== undefined) + Number(patch) + Number(input.append !== undefined);
  if (modes > 1) throw new Error('text、oldText/newText 和 append 只能选择一种修改方式。');
  let text = previous;
  if (input.text !== undefined) text = input.text;
  else if (patch) {
    if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') throw new Error('精确替换需要非空 oldText 和字符串 newText。');
    const index = previous.indexOf(input.oldText);
    if (index < 0) throw new Error('没有找到 oldText，请重新读取记忆后使用原文。');
    if (previous.indexOf(input.oldText, index + 1) >= 0) throw new Error('oldText 在记忆中出现多次，请加入相邻原文以唯一定位。');
    text = previous.slice(0, index) + input.newText + previous.slice(index + input.oldText.length);
  } else if (input.append !== undefined) {
    if (typeof input.append !== 'string' || !input.append) throw new Error('append 需要非空文字；需要换行时请在文字中包含换行。');
    text += input.append;
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('修改后的记忆须为 1 至 32000 字符。');
  return text;
}
