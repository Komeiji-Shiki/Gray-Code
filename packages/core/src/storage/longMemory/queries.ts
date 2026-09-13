import type { LongMemoryQuery, LongMemoryRecall, LongMemoryRecord, LongMemoryRead, LongMemoryReadResult, LongMemoryTopic, LongMemorySource, LongMemoryScope } from '@graycode/contracts';
import { invalid } from '../../errors';
import { MemoryMutationStore, validateMemoryTopic, validateMemoryVector, type RecordRow } from './mutations';
import { memoryTerms, memoryTokens } from './text';

interface QueryPlan { cte: string; parameters: Array<string | number>; filter: string; filters: Array<string | number> }

/** 目录、摘要和正文共用可见集合，不能在排序截断之后才检查账号或失效来源。 */
export class MemoryQueries {
  constructor(private readonly store: MemoryMutationStore) {}

  plan(query: LongMemoryQuery): QueryPlan {
    if (!Array.isArray(query.scopes) || query.scopes.length < 1 || query.scopes.length > 32) invalid('请选择 1 至 32 个授权记忆范围。');
    if (query.scopes.some(scope => scope.actorId !== query.scopes[0].actorId || scope.realm !== query.scopes[0].realm)) invalid('一次召回不能混用账号或剧情域。');
    if (new Set(query.scopes.map(scope => scope.id)).size !== query.scopes.length) invalid('记忆范围重复。');
    for (const scope of query.scopes) this.store.state(scope);
    if (!Number.isFinite(query.asOf) || !Number.isFinite(query.knownAt)) invalid('记忆查询时间无效。');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 || !Number.isSafeInteger(query.tokenBudget) || query.tokenBudget < 64 || query.tokenBudget > 32000) invalid('记忆查询条数或预算无效。');
    if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 32000)) invalid('记忆搜索文字过长。');
    if (query.topic) validateMemoryTopic(query.topic);
    const placeholders = query.scopes.map(() => '?').join(',');
    // 同一事实先选择当时已知且已经生效的最新修订，再判断截止时间，避免旧版本到期后复活。
    const cte = `WITH RECURSIVE visible AS (
      SELECT r.* FROM long_memory_records r WHERE r.scope_id IN(${placeholders}) AND r.recorded_at<=? AND r.valid_from<=?
      AND NOT EXISTS(SELECT 1 FROM long_memory_records n WHERE n.scope_id=r.scope_id AND n.id=r.id AND n.recorded_at<=? AND n.valid_from<=?
        AND (n.recorded_at>r.recorded_at OR (n.recorded_at=r.recorded_at AND n.version>r.version)))
      AND (r.valid_to IS NULL OR r.valid_to>?)
    ), dependency_invalid(row_id) AS (
      SELECT r.row_id FROM visible r JOIN long_memory_dependencies d ON d.record_row=r.row_id WHERE
        (d.parent_kind='source' AND NOT EXISTS(SELECT 1 FROM long_memory_sources s WHERE s.scope_id=r.scope_id AND s.id=d.parent_id
          AND s.version=d.parent_version AND s.recorded_at<=? AND NOT EXISTS(SELECT 1 FROM long_memory_sources newer
            WHERE newer.scope_id=s.scope_id AND newer.id=s.id AND newer.recorded_at<=? AND newer.version>s.version)))
        OR (d.parent_kind='record' AND NOT EXISTS(SELECT 1 FROM visible p WHERE p.scope_id=r.scope_id AND p.id=d.parent_id AND p.version=d.parent_version))
      UNION SELECT d.record_row FROM long_memory_dependencies d JOIN visible parent
        ON parent.scope_id=d.scope_id AND parent.id=d.parent_id AND parent.version=d.parent_version
        JOIN dependency_invalid bad ON bad.row_id=parent.row_id WHERE d.parent_kind='record'
    ), invalid_rows(row_id) AS (
      SELECT row_id FROM dependency_invalid
      UNION SELECT r.row_id FROM visible r JOIN long_memory_supersedes edge ON edge.scope_id=r.scope_id AND edge.original_id=r.id
        JOIN visible replacement ON replacement.row_id=edge.record_row
        WHERE NOT EXISTS(SELECT 1 FROM dependency_invalid bad WHERE bad.row_id=replacement.row_id)
      UNION SELECT d.record_row FROM long_memory_dependencies d JOIN visible parent
        ON parent.scope_id=d.scope_id AND parent.id=d.parent_id AND parent.version=d.parent_version
        JOIN invalid_rows bad ON bad.row_id=parent.row_id WHERE d.parent_kind='record'
    ), eligible AS (
      SELECT r.* FROM visible r WHERE NOT EXISTS(SELECT 1 FROM invalid_rows bad WHERE bad.row_id=r.row_id)
    ), unconfirmed_rows(row_id) AS (
      SELECT row_id FROM eligible WHERE kind<>'summary' AND confidence<>'confirmed'
      UNION SELECT r.row_id FROM eligible r JOIN long_memory_dependencies d ON d.record_row=r.row_id
        JOIN long_memory_sources s ON s.scope_id=r.scope_id AND s.id=d.parent_id AND s.version=d.parent_version
        WHERE d.parent_kind='source' AND json_extract(s.payload,'$.origin') IN('model','import')
      UNION SELECT d.record_row FROM long_memory_dependencies d JOIN eligible parent
        ON parent.scope_id=d.scope_id AND parent.id=d.parent_id AND parent.version=d.parent_version
        JOIN unconfirmed_rows bad ON bad.row_id=parent.row_id WHERE d.parent_kind='record'
    )`;
    const parameters: Array<string | number> = [...query.scopes.map(scope => scope.id), query.knownAt, query.asOf, query.knownAt, query.asOf, query.asOf, query.knownAt, query.knownAt];
    const conditions: string[] = [], filters: Array<string | number> = [];
    if (query.confirmedOnly) conditions.push(query.includeSummaries?"(r.confidence='confirmed' OR (r.kind='summary' AND NOT EXISTS(SELECT 1 FROM unconfirmed_rows bad WHERE bad.row_id=r.row_id)))":"r.confidence='confirmed'");
    if (query.kinds?.length) { conditions.push(`r.kind IN(${query.kinds.map(() => '?').join(',')})`); filters.push(...query.kinds); }
    for (let i = 0; i < (query.topic?.length ?? 0); i++) { conditions.push(`json_extract(r.topic,'$[${i}]')=?`); filters.push(query.topic![i]); }
    return { cte, parameters, filter: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', filters };
  }

  recall(query: LongMemoryQuery): LongMemoryRecall {
    const { cte, parameters, filter, filters } = this.plan(query);
    const db = this.store.db, terms = [...new Set(memoryTerms(query.text ?? ''))].slice(0,64);
    const candidateLimit = Math.max(40, query.limit)+1;
    let lexical: Array<RecordRow & { score: number }> = [];
    if (terms.length) {
      const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      lexical = db.prepare(`${cte} SELECT r.*,bm25(long_memory_terms) AS score FROM long_memory_terms
        JOIN eligible r ON r.row_id=long_memory_terms.rowid WHERE long_memory_terms MATCH ?${filter}
        ORDER BY score,r.id LIMIT ?`).all(...parameters, match, ...filters, candidateLimit) as typeof lexical;
    } else if (query.topic?.length || query.kinds?.length) {
      lexical = db.prepare(`${cte} SELECT r.*,0 AS score FROM eligible r WHERE 1=1${filter}
        ORDER BY (r.kind='summary') DESC,r.recorded_at DESC,r.id LIMIT ?`).all(...parameters, ...filters, candidateLimit) as typeof lexical;
    }
    const candidates = new Map<number, { row: RecordRow; score: number; reasons: string[] }>();
    const add = (rows: Array<RecordRow & { score: number }>, reason: string) => rows.forEach((row, rank) => {
      const item = candidates.get(row.row_id) ?? { row, score: 0, reasons: [] };
      item.score += 1 / (60 + rank + 1); item.reasons.push(reason); candidates.set(row.row_id, item);
    });
    add(lexical, terms.length ? '关键词' : '主题');
    let vectorAvailable = false;
    if (query.vector) {
      validateMemoryVector(query.vector);
      const rows = db.prepare(`${cte} SELECT r.*,v.value AS vector FROM long_memory_vectors v JOIN eligible r ON r.row_id=v.record_row
        WHERE v.model=? AND v.dimensions=?${filter}`).all(...parameters, query.vector.model, query.vector.dimensions, ...filters) as Array<RecordRow & { vector: Buffer }>;
      vectorAvailable = rows.length > 0;
      const norm = Math.sqrt(query.vector.values.reduce((sum, x) => sum + x*x, 0));
      const semantic = rows.map(row => {
        let dot = 0, square = 0;
        for (let i=0; i<query.vector!.dimensions; i++) { const value = row.vector.readFloatLE(i*4); dot += value*query.vector!.values[i]; square += value*value; }
        return { ...row, score: norm && square ? dot/(norm*Math.sqrt(square)) : 0 };
      }).filter(row => row.score > 0).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id)).slice(0,candidateLimit);
      add(semantic, '语义');
    }
    const hits: LongMemoryRecall['hits'] = []; let estimatedTokens = 0, truncated = false;
    for (const item of [...candidates.values()].sort((a,b) => b.score-a.score || a.row.id.localeCompare(b.row.id))) {
      const record = JSON.parse(item.row.payload) as LongMemoryRecord;
      const cost = memoryTokens(record.text) + memoryTokens(JSON.stringify([record.id, record.topic, record.subject, record.dependencies])) + 24;
      if (hits.length >= query.limit || estimatedTokens + cost > query.tokenBudget) { truncated = true; continue; }
      const conflicts = record.attribute ? (db.prepare(`${cte} SELECT r.id FROM eligible r WHERE r.scope_id=? AND r.id<>? AND r.subject=?
        AND r.attribute=? AND r.value IS NOT ? AND (r.valid_to IS NULL OR r.valid_to>?) LIMIT 20`)
        .all(...parameters, record.scopeId, record.id, record.subject, record.attribute, record.value ?? null, query.asOf) as Array<{ id: string }>).map(row => row.id) : [];
      hits.push({ record, score: item.score, reasons: item.reasons, conflicts }); estimatedTokens += cost;
    }
    return { hits, estimatedTokens, method: vectorAvailable ? 'hybrid' : 'keyword', ...(vectorAvailable ? { vectorModel: query.vector!.model } : {}),
      states: query.scopes.map(scope => this.store.state(scope)), truncated };
  }

  topics(query: LongMemoryQuery): { topics: LongMemoryTopic[]; estimatedTokens: number; truncated: boolean } {
    const { cte, parameters, filter, filters } = this.plan(query), depth = query.topic?.length ?? 0;
    const rows = this.store.db.prepare(`${cte} SELECT r.scope_id,json_extract(r.topic,'$[${depth}]') AS child,count(*) AS count
      FROM eligible r WHERE json_array_length(r.topic)>?${filter} GROUP BY r.scope_id,child ORDER BY count DESC,child LIMIT ?`)
      .all(...parameters, depth, ...filters, query.limit + 1) as Array<{ scope_id: string; child: string; count: number }>;
    const topics: LongMemoryTopic[] = []; let estimatedTokens = 0, truncated = rows.length > query.limit;
    for (const row of rows.slice(0,query.limit)) {
      const topic = [...query.topic ?? [], row.child];
      const summaries = this.store.db.prepare(`${cte} SELECT r.id,r.version,r.payload FROM eligible r WHERE r.scope_id=? AND r.kind='summary' AND r.topic=?
        ORDER BY r.recorded_at DESC,r.id LIMIT 2`).all(...parameters, row.scope_id, JSON.stringify(topic)) as Array<{ id: string; version: number; payload: string }>;
      const entry: LongMemoryTopic = { scopeId: row.scope_id, path: topic, records: row.count,
        summaries: summaries.map(value => ({ id: value.id, version: value.version, text: (JSON.parse(value.payload) as LongMemoryRecord).text })) };
      // 目录优先给出路径和数量，摘要过长时保留编号供 memory_read 按需展开。
      for (const summary of entry.summaries) if (memoryTokens(summary.text)>180) summary.text = '';
      const cost = memoryTokens(JSON.stringify(entry));
      if (estimatedTokens + cost > query.tokenBudget) { truncated = true; break; }
      topics.push(entry); estimatedTokens += cost;
    }
    return { topics, estimatedTokens, truncated };
  }

  read(input: LongMemoryRead): LongMemoryReadResult {
    const { cte, parameters } = this.plan(input.query);
    if (!Array.isArray(input.references) || input.references.length>100) invalid('一次最多展开 100 条记忆。');
    const scopes = new Set(input.query.scopes.map(scope=>scope.id));
    const records: LongMemoryRecord[] = [], sources = new Map<string,LongMemorySource>();
    const unavailable: LongMemoryReadResult['unavailable'] = []; let estimatedTokens = 0;
    for (const ref of input.references) {
      if (!scopes.has(ref.scopeId)) invalid('要展开的记忆不在授权范围中。');
      const row = this.store.db.prepare(`${cte} SELECT r.* FROM eligible r WHERE r.scope_id=? AND r.id=?${ref.version===undefined?'':' AND r.version=?'}`)
        .get(...parameters, ref.scopeId, ref.id, ...ref.version===undefined?[]:[ref.version]) as RecordRow | undefined;
      if (!row) { unavailable.push(ref); continue; }
      const value = JSON.parse(row.payload) as LongMemoryRecord;
      const cost = memoryTokens(JSON.stringify(value));
      if (records.length>=input.query.limit || estimatedTokens+cost>input.query.tokenBudget) { unavailable.push(ref); continue; }
      records.push(value); estimatedTokens+=cost;
      if (input.includeSources) for (const dependency of value.dependencies) {
        if (dependency.kind!=='source') continue;
        const source = this.store.source(value.scopeId,dependency.id,dependency.version);
        if (!source || sources.has(`${value.scopeId}:${dependency.id}:${dependency.version}`)) continue;
        const original = JSON.parse(source.payload) as LongMemorySource, size = memoryTokens(JSON.stringify(original));
        if (estimatedTokens+size>input.query.tokenBudget) continue;
        sources.set(`${value.scopeId}:${dependency.id}:${dependency.version}`,original); estimatedTokens+=size;
      }
    }
    return { records,sources:[...sources.values()],unavailable,estimatedTokens };
  }

  revisions(scope: LongMemoryScope, id: string): LongMemoryRecord[] {
    this.store.state(scope);
    return (this.store.db.prepare('SELECT payload FROM long_memory_records WHERE scope_id=? AND id=? ORDER BY version DESC LIMIT 100').all(scope.id,id) as Array<{payload:string}>)
      .map(row=>JSON.parse(row.payload) as LongMemoryRecord);
  }
  sources(scope:LongMemoryScope,references:Array<{id:string;version:number}>):LongMemorySource[]{
    this.store.state(scope);if(!Array.isArray(references)||references.length>256)invalid('来源读取批次过大。');
    return references.flatMap(ref=>{
      const row=this.store.source(scope.id,ref.id);return row?.version===ref.version?[JSON.parse(row.payload) as LongMemorySource]:[];
    });
  }
  recordVersions(scope:LongMemoryScope,references:Array<{id:string;version?:number}>):LongMemoryRecord[]{
    this.store.state(scope);if(!Array.isArray(references)||references.length>256)invalid('记忆版本读取批次过大。');
    return references.flatMap(ref=>{const row=this.store.record(scope.id,ref.id,ref.version);return row?[JSON.parse(row.payload) as LongMemoryRecord]:[];});
  }
  inspect(scope:LongMemoryScope,id:string):{revisions:LongMemoryRecord[];sources:LongMemorySource[];parents:LongMemoryRecord[];activeVersion?:number}{
    const revisions=this.revisions(scope,id),sources=new Map<string,LongMemorySource>(),parents=new Map<string,LongMemoryRecord>();
    for(const revision of revisions)for(const ref of revision.dependencies){
      const key=JSON.stringify(ref);
      if(ref.kind==='source'){
        const row=this.store.source(scope.id,ref.id,ref.version);if(row)sources.set(key,JSON.parse(row.payload));
      }else{
        const row=this.store.record(scope.id,ref.id,ref.version);if(row)parents.set(key,JSON.parse(row.payload));
      }
    }
    const now=Date.now(),{cte,parameters}=this.plan({scopes:[scope],asOf:now,knownAt:now,limit:1,tokenBudget:256});
    const active=this.store.db.prepare(`${cte} SELECT version FROM eligible WHERE scope_id=? AND id=?`).get(...parameters,scope.id,id) as {version:number}|undefined;
    return {revisions,sources:[...sources.values()],parents:[...parents.values()],activeVersion:active?.version};
  }
}
