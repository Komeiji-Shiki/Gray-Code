/** 偏移以 UTF-16 单元计数，保留 BOM、换行和输入法提交后的原文。 */
export interface DocumentTextPatch { start: number; deleteCount: number; text: string }

/**
 * 已知的变更覆盖范围：基线 [start, start + deleteCount) 被替换为新文本 [start, start + insertCount)。
 * 只描述长度，不携带文本；范围外的前后缀由调用方保证两侧相同，范围内可能仍有相同字符。
 */
export interface DocumentChangeRegion { start: number; deleteCount: number; insertCount: number }

/** 编辑器单次内容事件中的一处替换；偏移都基于事件发生前的文本，各处互不重叠。 */
export interface DocumentContentChange { rangeOffset: number; rangeLength: number; text: string }

const validRegion = (region: DocumentChangeRegion, before: string, after: string) =>
  Number.isSafeInteger(region.start) && Number.isSafeInteger(region.deleteCount) && Number.isSafeInteger(region.insertCount)
  && region.start >= 0 && region.deleteCount >= 0 && region.insertCount >= 0
  && region.start + region.deleteCount <= before.length && region.start + region.insertCount <= after.length
  && before.length - region.deleteCount === after.length - region.insertCount;

/**
 * 生成单段补丁。传入 region 时只在该范围内收缩前后缀，长度一致即信任范围外相同，
 * 避免改一个字符也比较整篇文本；范围与两侧长度对不上时回退为全文比较。
 */
export function documentTextPatch(before: string, after: string, region?: DocumentChangeRegion): DocumentTextPatch {
  let start = 0, end = before.length, nextEnd = after.length;
  if (region && validRegion(region, before, after)) {
    start = region.start; end = region.start + region.deleteCount; nextEnd = region.start + region.insertCount;
  }
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, deleteCount: end - start, text: after.slice(start, nextEnd) };
}

/**
 * 把一次内容事件的多处替换合并为覆盖范围；offset 用于补偿编辑器偏移不含的前导字符（如 BOM）。
 * 偏移非法或彼此重叠时返回 undefined，调用方应回退到全文比较。
 */
export function documentChangeRegion(changes: readonly DocumentContentChange[], offset = 0): DocumentChangeRegion | undefined {
  if (!changes.length) return undefined;
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  let previousEnd = -1, delta = 0;
  for (const change of sorted) {
    if (!Number.isSafeInteger(change.rangeOffset) || !Number.isSafeInteger(change.rangeLength) || typeof change.text !== 'string'
      || change.rangeOffset < 0 || change.rangeLength < 0 || change.rangeOffset < previousEnd) return undefined;
    previousEnd = change.rangeOffset + change.rangeLength;
    delta += change.text.length - change.rangeLength;
  }
  const first = sorted[0], last = sorted[sorted.length - 1];
  const start = first.rangeOffset + offset, deleteCount = last.rangeOffset + last.rangeLength + offset - start;
  return { start, deleteCount, insertCount: deleteCount + delta };
}

/** 依次发生的两段变更（基线→中间→结果）合并为相对基线的一段覆盖范围。 */
export function composeDocumentChangeRegions(first: DocumentChangeRegion, second: DocumentChangeRegion): DocumentChangeRegion {
  const start = Math.min(first.start, second.start);
  // 中间文本上的覆盖终点，分别换算回基线与结果坐标。
  const middleEnd = Math.max(first.start + first.insertCount, second.start + second.deleteCount);
  const deleteCount = middleEnd + first.deleteCount - first.insertCount - start;
  const insertCount = middleEnd + second.insertCount - second.deleteCount - start;
  return { start, deleteCount, insertCount };
}

/** base 经 region 变为 text；region 缺省表示两者相同。只在使用方的基线和待发文本与两端一致时才可作范围提示。 */
export interface TrackedDocumentChange { base: string; text: string; region?: DocumentChangeRegion }

/**
 * 追加一次编辑。编辑没有可靠范围（外部重置、移动端全文输入等）时返回 undefined，后续发送回退全文比较；
 * 编辑前文本与已记录的结果不同，说明中间有未记录的变化，只能从这次编辑前的文本重新起算。
 */
export function trackDocumentChange(tracked: TrackedDocumentChange | undefined, text: string,
  edit?: { previous: string; region: DocumentChangeRegion }): TrackedDocumentChange | undefined {
  if (!edit) return undefined;
  if (!tracked || tracked.text !== edit.previous) return { base: edit.previous, text, region: edit.region };
  return { base: tracked.base, text, region: tracked.region ? composeDocumentChangeRegions(tracked.region, edit.region) : edit.region };
}

export function applyDocumentTextPatch(before: string, patch: DocumentTextPatch): string {
  if (!patch || !Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.deleteCount)
    || patch.start < 0 || patch.deleteCount < 0 || patch.start + patch.deleteCount > before.length || typeof patch.text !== 'string')
    throw new Error('DOCUMENT_CONFLICT: Invalid editor patch.');
  return before.slice(0, patch.start) + patch.text + before.slice(patch.start + patch.deleteCount);
}
