import type { LongMemoryBrowse, LongMemoryBrowseResult, LongMemoryQuery, LongMemoryRecord } from '@graycode/contracts';
import { invalid } from '../../errors';
import type { MemoryMutationStore } from './mutations';
import type { QueryPlan } from './queries';
import { readMemoryCursor, writeMemoryCursor } from './cursor';
import { memoryDigest, memoryTerms } from './text';

/** 人工管理按条目分页，正文预览有界；模型召回仍独立遵守上下文预算。 */
export function browseMemory(store: MemoryMutationStore, input: LongMemoryBrowse, planQuery: (query: LongMemoryQuery) => QueryPlan): LongMemoryBrowseResult {
  const limit = input.limit ?? 40, status = input.status ?? 'current', previous = readMemoryCursor(input.cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['current','inactive','all'].includes(status)
    || input.confidence !== undefined && !['confirmed','inferred','disputed'].includes(input.confidence)
    || input.kind !== undefined && !['fact','preference','experience','project','procedure','event','summary'].includes(input.kind)) invalid('记忆列表筛选条件无效。');
  const now = Date.now(), asOf = previous?.asOf ?? now, knownAt = previous?.knownAt ?? now, offset = previous?.offset ?? 0;
  const plan = planQuery({ scopes: [input.scope], text: input.text, topic: input.topic, asOf, knownAt, limit, tokenBudget: 32000 });
  const state = store.state(input.scope), fingerprint = memoryDigest(['browse', state.id, state.revision, state.invalidation,
    input.text ?? '', input.topic ?? [], input.kind ?? '', input.confidence ?? '', status]);
  if (previous && previous.fingerprint !== fingerprint) invalid('记忆列表或筛选条件已变化，请重新读取第一页。');
  const where: string[] = ['r.scope_id=?'], parameters: Array<string | number> = [input.scope.id];
  // IN 让 SQLite 建立编号集合；LEFT JOIN 会在这里逐条扫描整个有效集合。
  const active = 'r.row_id IN(SELECT row_id FROM eligible)';
  if (status === 'current') where.push(active);
  else {
    where.push('NOT EXISTS(SELECT 1 FROM long_memory_records newer WHERE newer.scope_id=r.scope_id AND newer.id=r.id AND newer.version>r.version)');
    if (status === 'inactive') where.push(`NOT (${active})`);
  }
  if (input.kind) { where.push('r.kind=?'); parameters.push(input.kind); }
  if (input.confidence) { where.push('r.confidence=?'); parameters.push(input.confidence); }
  for (let index = 0; index < (input.topic?.length ?? 0); index++) { where.push(`json_extract(r.topic,'$[${index}]')=?`); parameters.push(input.topic![index]); }
  const terms = [...new Set(memoryTerms(input.text ?? ''))].slice(0, 64);
  if (input.text?.trim()) {
    if (terms.length) { where.push('r.row_id IN(SELECT rowid FROM long_memory_terms WHERE long_memory_terms MATCH ?)'); parameters.push(terms.map(term => `"${term.replaceAll('"','""')}"`).join(' OR ')); }
    else { where.push("instr(lower(json_extract(r.payload,'$.text')),lower(?))>0"); parameters.push(input.text.trim()); }
  }
  const rows = store.db.prepare(`${plan.cte}, page AS (
    SELECT r.row_id,r.recorded_at AS sort_at,r.id AS sort_id,r.version AS sort_version,(${status==='current'?'1':status==='inactive'?'0':active}) AS active,count(*) OVER() AS total
    FROM long_memory_records r WHERE ${where.join(' AND ')}
    ORDER BY r.recorded_at DESC,r.id,r.version DESC LIMIT ? OFFSET ?
  ) SELECT body.payload,page.active,page.total FROM page JOIN long_memory_records body ON body.row_id=page.row_id ORDER BY page.sort_at DESC,page.sort_id,page.sort_version DESC`)
    .all(...plan.parameters, ...parameters, limit, offset) as Array<{ payload:string; active:number; total:number }>;
  const total = rows[0]?.total ?? 0;
  const items = rows.map(row => {
    const record = JSON.parse(row.payload) as LongMemoryRecord;
    const end = /[\uD800-\uDBFF]/.test(record.text[599] ?? '') && /[\uDC00-\uDFFF]/.test(record.text[600] ?? '') ? 599 : 600;
    return { id:record.id,scopeId:record.scopeId,version:record.version,kind:record.kind,origin:record.origin,confidence:record.confidence,
      subject:record.subject,topic:record.topic,recordedAt:record.recordedAt,preview:record.text.slice(0,end),moreText:record.text.length>end,active:!!row.active };
  });
  return { items, offset, total, ...(offset + items.length < total ? { nextCursor: writeMemoryCursor({ offset: offset + items.length, asOf, knownAt, fingerprint }) } : {}) };
}
