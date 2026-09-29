/** 偏移以 UTF-16 单元计数，保留 BOM、换行和输入法提交后的原文。 */
export interface DocumentTextPatch { start: number; deleteCount: number; text: string }

export function documentTextPatch(before: string, after: string): DocumentTextPatch {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, deleteCount: end - start, text: after.slice(start, nextEnd) };
}

export function applyDocumentTextPatch(before: string, patch: DocumentTextPatch): string {
  if (!patch || !Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.deleteCount)
    || patch.start < 0 || patch.deleteCount < 0 || patch.start + patch.deleteCount > before.length || typeof patch.text !== 'string')
    throw new Error('DOCUMENT_CONFLICT: Invalid editor patch.');
  return before.slice(0, patch.start) + patch.text + before.slice(patch.start + patch.deleteCount);
}
