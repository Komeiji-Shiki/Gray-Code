import type { LongMemoryRead, LongMemoryReadResult, LongMemoryRecord, LongMemorySource, LongMemoryTextPage } from '@graycode/contracts';
import { invalid } from '../../errors';
import type { MemoryMutationStore } from './mutations';
import { memoryTokens } from './text';

/** 分段仍绑定一个当前有效的确切记录版本，便于后续修订、遗忘和上下文清理沿用同一依据。 */
export function readMemoryPage(store: MemoryMutationStore, input: LongMemoryRead, plan: { cte: string; parameters: Array<string | number> }): LongMemoryReadResult {
  const request = input.page!, ref = request.record, offset = request.offset ?? 0;
  if (input.references.length || !ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1
    || !input.query.scopes.some(scope => scope.id === ref.scopeId) || !Number.isSafeInteger(offset) || offset < 0
    || request.sourceId !== undefined && typeof request.sourceId !== 'string') invalid('分段读取需要单个授权记录的确切版本与有效位置，不能同时指定整条读取。');
  const empty: LongMemoryReadResult = { records: [], sources: [], unavailable: [], estimatedTokens: 0 };
  const row = store.db.prepare(`${plan.cte} SELECT body.payload FROM eligible r JOIN long_memory_records body ON body.row_id=r.row_id
    WHERE r.scope_id=? AND r.id=? AND r.version=?`).get(...plan.parameters, ref.scopeId, ref.id, ref.version) as { payload: string } | undefined;
  if (!row) return { ...empty, unavailable: [ref] };
  const { text: recordText, ...record } = JSON.parse(row.payload) as LongMemoryRecord;
  let text = recordText, source: Omit<LongMemorySource, 'text'> | undefined;
  if (request.sourceId !== undefined) {
    const dependency = record.dependencies.find(item => item.kind === 'source' && item.id === request.sourceId);
    if (!dependency) invalid('所选来源不属于这条记忆的依据。');
    const row = store.source(record.scopeId, dependency.id, dependency.version);
    if (!row) return { ...empty, unavailable: [ref] };
    const { text: sourceText, ...metadata } = JSON.parse(row.payload) as LongMemorySource; text = sourceText; source = metadata;
  }
  if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') && /[\uD800-\uDBFF]/.test(text[offset - 1])) invalid('分段位置无效，请沿用返回的 nextOffset。');
  const part = (length: number): LongMemoryTextPage => {
    let end = offset + length;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    return { record, ...(source ? { source } : {}), offset, end, totalCharacters: text.length, text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
  };
  const cost = (page: LongMemoryTextPage) => memoryTokens(JSON.stringify(page));
  let page = part(text.length - offset);
  if (cost(page) > input.query.tokenBudget) {
    let low = 0, high = text.length - offset;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (cost(part(middle)) <= input.query.tokenBudget) low = middle; else high = middle - 1; }
    page = part(low);
    if (page.end <= offset) {
      const pair = /[\uD800-\uDBFF]/.test(text[offset] ?? '') && /[\uDC00-\uDFFF]/.test(text[offset + 1] ?? '');
      const minimum = cost(part(offset === text.length ? 0 : pair ? 2 : 1));
      return { ...empty, truncated: true, requiredTokenBudget: minimum, omitted: [{ kind: source ? 'source' : 'record', scopeId: ref.scopeId,
        id: source?.id ?? ref.id, version: source?.version ?? ref.version, reason: 'token_budget', estimatedTokens: minimum }] };
    }
  }
  return { ...empty, page, estimatedTokens: cost(page), ...(page.nextOffset !== undefined ? { truncated: true } : {}) };
}
