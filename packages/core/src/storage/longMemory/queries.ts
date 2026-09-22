import type { LongMemoryQuery, LongMemoryRecall, LongMemoryRecord, LongMemoryRead, LongMemoryReadResult, LongMemoryTopic, LongMemorySource, LongMemoryScope } from '@graycode/contracts';
import { invalid } from '../../errors';
import { MemoryMutationStore, validateMemoryTopic, validateMemoryVector, type RecordRow } from './mutations';
import { memoryDigest, memoryTerms, memoryTokens } from './text';
import { rankVectors, type VectorRankingRequest } from './vectors';
import type { LongMemoryGraph, LongMemoryGraphNode } from '@graycode/contracts';
import type { LongMemoryTopicQuery, LongMemoryTopicPage } from '@graycode/contracts';
import { readMemoryPage } from './pages';

interface QueryPlan { cte: string; parameters: Array<string | number>; filter: string; filters: Array<string | number> }
interface SemanticCandidates { available: boolean; matches: Array<{ rowId: number; score: number }> }

/** 目录、摘要和正文共用可见集合，不能在排序截断之后才检查账号或失效来源。 */
export class MemoryQueries {
  constructor(private readonly store: MemoryMutationStore) {}

  private confirmation(query: LongMemoryQuery): string {
    if (!query.confirmedOnly) return '';
    return query.includeSummaries ? "(r.confidence='confirmed' OR (r.kind='summary' AND NOT EXISTS(SELECT 1 FROM unconfirmed_rows bad WHERE bad.row_id=r.row_id)))" : "r.confidence='confirmed'";
  }

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
    // 同一来源可能被许多分段引用；先建立紧凑的有效编号集合，避免反复读取大段来源正文。
    const cte = `WITH RECURSIVE visible_sources AS MATERIALIZED (
      SELECT s.scope_id,s.id,s.version FROM long_memory_sources s WHERE s.scope_id IN(${placeholders}) AND s.recorded_at<=?
        AND NOT EXISTS(SELECT 1 FROM long_memory_sources newer WHERE newer.scope_id=s.scope_id AND newer.id=s.id AND newer.recorded_at<=? AND newer.version>s.version)
    ), visible AS MATERIALIZED (
      SELECT r.row_id,r.scope_id,r.id,r.version,r.recorded_at,r.valid_from,r.valid_to,r.kind,r.confidence,r.subject,r.attribute,r.value,r.topic
      FROM long_memory_records r WHERE r.scope_id IN(${placeholders}) AND r.recorded_at<=? AND r.valid_from<=?
      AND NOT EXISTS(SELECT 1 FROM long_memory_records n WHERE n.scope_id=r.scope_id AND n.id=r.id AND n.recorded_at<=? AND n.valid_from<=?
        AND (n.recorded_at>r.recorded_at OR (n.recorded_at=r.recorded_at AND n.version>r.version)))
      AND (r.valid_to IS NULL OR r.valid_to>?)
    ), dependency_invalid(row_id) AS (
      SELECT r.row_id FROM visible r JOIN long_memory_dependencies d ON d.record_row=r.row_id WHERE
        (d.parent_kind='source' AND NOT EXISTS(SELECT 1 FROM visible_sources s WHERE s.scope_id=r.scope_id AND s.id=d.parent_id AND s.version=d.parent_version))
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
    const parameters: Array<string | number> = [...query.scopes.map(scope => scope.id), query.knownAt, query.knownAt,
      ...query.scopes.map(scope => scope.id), query.knownAt, query.asOf, query.knownAt, query.asOf, query.asOf];
    const conditions: string[] = [], filters: Array<string | number> = [];
    if (query.confirmedOnly) conditions.push(this.confirmation(query));
    if (query.kinds?.length) { conditions.push(`r.kind IN(${query.kinds.map(() => '?').join(',')})`); filters.push(...query.kinds); }
    for (let i = 0; i < (query.topic?.length ?? 0); i++) { conditions.push(`json_extract(r.topic,'$[${i}]')=?`); filters.push(query.topic![i]); }
    return { cte, parameters, filter: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', filters };
  }

  prepareVectors(query: LongMemoryQuery, previousKey?: string): { key: string; rowIds: number[]; input: VectorRankingRequest } {
    const vector = query.vector!; validateMemoryVector(vector);
    const { cte, parameters, filter, filters } = this.plan(query);
    const rows = this.store.db.prepare(`${cte} SELECT r.row_id,r.id FROM long_memory_vectors v JOIN eligible r ON r.row_id=v.record_row
      WHERE v.model=? AND v.dimensions=?${filter}`).all(...parameters, vector.model, vector.dimensions, ...filters) as Array<{ row_id: number; id: string }>;
    const rowIds = rows.map(row => row.row_id), key = JSON.stringify([vector.model, vector.dimensions, rowIds]);
    const input: VectorRankingRequest = { dimensions: vector.dimensions, values: vector.values,
      ids: rows.map(row => row.id), limit: Math.max(40, query.limit) + 1 };
    if (key !== previousKey) {
      const bytes = vector.dimensions * 4, packed = Buffer.allocUnsafeSlow(rows.length * bytes);
      const offsets = new Map(rowIds.map((id, index) => [id, index]));
      for (let start = 0; start < rowIds.length; start += 500) {
        const batch = rowIds.slice(start, start + 500);
        const values = this.store.db.prepare(`SELECT record_row,value FROM long_memory_vectors WHERE record_row IN(${batch.map(() => '?').join(',')})`)
          .all(...batch) as Array<{ record_row: number; value: Buffer }>;
        for (const value of values) if (value.value.copy(packed, offsets.get(value.record_row)! * bytes, 0, bytes) !== bytes)
          throw new Error('记忆向量数据不完整。');
      }
      input.vectors = packed.buffer as ArrayBuffer;
    }
    return { key, rowIds, input };
  }

  recall(query: LongMemoryQuery, semanticCandidates?: SemanticCandidates): LongMemoryRecall {
    const { cte, parameters, filter, filters } = this.plan(query);
    const db = this.store.db, terms = [...new Set(memoryTerms(query.text ?? ''))].slice(0,64);
    const candidateLimit = Math.max(40, query.limit)+1;
    let lexical: Array<RecordRow & { score: number }> = [];
    if (terms.length) {
      const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      lexical = db.prepare(`${cte} SELECT body.*,bm25(long_memory_terms) AS score FROM long_memory_terms
        JOIN eligible r ON r.row_id=long_memory_terms.rowid JOIN long_memory_records body ON body.row_id=r.row_id WHERE long_memory_terms MATCH ?${filter}
        ORDER BY score,r.id LIMIT ?`).all(...parameters, match, ...filters, candidateLimit) as typeof lexical;
    } else if (query.topic?.length || query.kinds?.length) {
      lexical = db.prepare(`${cte} SELECT body.*,0 AS score FROM eligible r JOIN long_memory_records body ON body.row_id=r.row_id WHERE 1=1${filter}
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
      if (!semanticCandidates) {
        const prepared = this.prepareVectors(query);
        semanticCandidates = { available: prepared.rowIds.length > 0,
          matches: rankVectors({ ...prepared.input, vectors: prepared.input.vectors! }).map(item => ({ rowId: prepared.rowIds[item.index], score: item.score })) };
      }
      vectorAvailable = semanticCandidates.available;
      const statement = db.prepare('SELECT * FROM long_memory_records WHERE row_id=?');
      const semantic = semanticCandidates.matches.map(item => ({ ...statement.get(item.rowId) as RecordRow, score: item.score }));
      add(semantic, '语义');
    }
    const hits: LongMemoryRecall['hits'] = [], conflictRows = new Map<number, LongMemoryRecall['hits'][number]>(); let estimatedTokens = 0, truncated = false;
    for (const item of [...candidates.values()].sort((a,b) => b.score-a.score || a.row.id.localeCompare(b.row.id))) {
      const record = JSON.parse(item.row.payload) as LongMemoryRecord;
      const cost = memoryTokens(record.text) + memoryTokens(JSON.stringify([record.id, record.topic, record.subject, record.dependencies])) + 24;
      if (hits.length >= query.limit || estimatedTokens + cost > query.tokenBudget) { truncated = true; continue; }
      const hit = { record, score: item.score, reasons: item.reasons, conflicts: [] as string[] };
      hits.push(hit); if (record.attribute) conflictRows.set(item.row.row_id, hit); estimatedTokens += cost;
    }
    // 同一批命中的不同说法只计算一次有效集合，不对每条事实重新展开整个依赖图。
    if (conflictRows.size) {
      const rows = db.prepare(`${cte}, conflicts AS (
        SELECT chosen.row_id,r.id,row_number() OVER(PARTITION BY chosen.row_id ORDER BY r.id) AS position
        FROM long_memory_records chosen JOIN eligible r ON r.scope_id=chosen.scope_id AND r.subject=chosen.subject
          AND r.attribute=chosen.attribute AND r.id<>chosen.id AND r.value IS NOT chosen.value
        WHERE chosen.row_id IN(${[...conflictRows.keys()].map(() => '?').join(',')})
      ) SELECT row_id,id FROM conflicts WHERE position<=20 ORDER BY row_id,position`).all(...parameters, ...conflictRows.keys()) as Array<{row_id:number;id:string}>;
      for (const row of rows) conflictRows.get(row.row_id)!.conflicts.push(row.id);
    }
    return { hits, estimatedTokens, method: vectorAvailable ? 'hybrid' : 'keyword', ...(vectorAvailable ? { vectorModel: query.vector!.model } : {}),
      states: query.scopes.map(scope => this.store.state(scope)), truncated };
  }

  topics(input: LongMemoryTopicQuery): LongMemoryTopicPage {
    let query = input, offset = 0, previous: unknown[] | undefined;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(input.cursor)) invalid('主题续页编号无效。');
      try { previous = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { invalid('主题续页编号无效。'); }
      if (!Array.isArray(previous) || previous.length !== 4 || !Number.isSafeInteger(previous[0]) || Number(previous[0]) < 0
        || !Number.isFinite(previous[1]) || !Number.isFinite(previous[2]) || typeof previous[3] !== 'string') invalid('主题续页编号无效。');
      offset = previous[0] as number; query = { ...input, asOf: previous[1] as number, knownAt: previous[2] as number };
    }
    const { cte, parameters, filter, filters } = this.plan(query), depth = query.topic?.length ?? 0;
    const fingerprint = memoryDigest([query.scopes.map(scope => { const state = this.store.state(scope); return [scope.id, state.revision, state.invalidation]; }),
      query.topic ?? [], query.kinds ?? [], !!query.confirmedOnly, !!query.includeSummaries]);
    if (previous && previous[3] !== fingerprint) invalid('记忆目录或筛选条件已变化，请从当前主题重新读取。');
    const rows = this.store.db.prepare(`${cte} SELECT r.scope_id,json_extract(r.topic,'$[${depth}]') AS child,count(*) AS count
      FROM eligible r WHERE json_array_length(r.topic)>?${filter} GROUP BY r.scope_id,child ORDER BY count DESC,child,r.scope_id LIMIT ? OFFSET ?`)
      .all(...parameters, depth, ...filters, query.limit + 1, offset) as Array<{ scope_id: string; child: string; count: number }>;
    const topics: LongMemoryTopic[] = []; let estimatedTokens = 0, truncated = rows.length > query.limit, requiredTokenBudget: number | undefined;
    const page = rows.slice(0, query.limit), summariesByTopic = new Map<string, LongMemoryTopic['summaries']>();
    if (page.length) {
      const confirmation = this.confirmation(query);
      const summaries = this.store.db.prepare(`${cte}, selected_summaries AS (
        SELECT r.row_id,r.scope_id,r.topic,r.id,r.version,row_number() OVER(PARTITION BY r.scope_id,r.topic ORDER BY r.recorded_at DESC,r.id) AS position
        FROM eligible r WHERE r.kind='summary' ${confirmation ? 'AND '+confirmation : ''}
          AND (${page.map(() => '(r.scope_id=? AND r.topic=?)').join(' OR ')})
      ) SELECT s.*,body.payload FROM selected_summaries s JOIN long_memory_records body ON body.row_id=s.row_id
        WHERE position<=2 ORDER BY s.scope_id,s.topic,position`).all(...parameters, ...page.flatMap(row => [row.scope_id, JSON.stringify([...query.topic ?? [], row.child])])) as Array<{ scope_id:string;topic:string;id:string;version:number;payload:string }>;
      for (const row of summaries) {
        const key = JSON.stringify([row.scope_id, row.topic]), values = summariesByTopic.get(key) ?? [];
        values.push({ id: row.id, version: row.version, text: (JSON.parse(row.payload) as LongMemoryRecord).text }); summariesByTopic.set(key, values);
      }
    }
    for (const row of page) {
      const topic = [...query.topic ?? [], row.child];
      const entry: LongMemoryTopic = { scopeId: row.scope_id, path: topic, records: row.count,
        summaries: summariesByTopic.get(JSON.stringify([row.scope_id, JSON.stringify(topic)])) ?? [] };
      // 目录优先给出路径和数量，摘要过长时保留编号供 memory_read 按需展开。
      for (const summary of entry.summaries) if (memoryTokens(summary.text)>180) summary.text = '';
      const cost = memoryTokens(JSON.stringify(entry));
      if (estimatedTokens + cost > query.tokenBudget) { truncated = true; if (!topics.length) requiredTokenBudget = cost; break; }
      topics.push(entry); estimatedTokens += cost;
    }
    return { topics, estimatedTokens, truncated,
      ...(truncated ? { nextCursor: Buffer.from(JSON.stringify([offset + topics.length, query.asOf, query.knownAt, fingerprint])).toString('base64url') } : {}),
      ...(requiredTokenBudget !== undefined ? { requiredTokenBudget } : {}) };
  }

  read(input: LongMemoryRead): LongMemoryReadResult {
    const { cte, parameters } = this.plan(input.query);
    if (!Array.isArray(input.references) || input.references.length>100) invalid('一次最多展开 100 条记忆。');
    if (input.page) return readMemoryPage(this.store, input, { cte, parameters });
    const scopes = new Set(input.query.scopes.map(scope=>scope.id));
    for (const ref of input.references) if (!scopes.has(ref.scopeId)) invalid('要展开的记忆不在授权范围中。');
    // 同一批只计算一次来源可见性，避免每个编号都重复遍历修订和摘要依赖。
    const rows = input.references.length ? this.store.db.prepare(`${cte} SELECT body.* FROM eligible r JOIN long_memory_records body ON body.row_id=r.row_id WHERE ${input.references.map(() => '(r.scope_id=? AND r.id=?)').join(' OR ')}`)
      .all(...parameters, ...input.references.flatMap(ref => [ref.scopeId, ref.id])) as RecordRow[] : [];
    const byId = new Map(rows.map(row => [JSON.stringify([row.scope_id, row.id]), row]));
    const records: LongMemoryRecord[] = [], sources = new Map<string,LongMemorySource>();
    const unavailable: LongMemoryReadResult['unavailable'] = []; let estimatedTokens = 0;
    const omitted = new Map<string, NonNullable<LongMemoryReadResult['omitted']>[number]>();
    for (const ref of input.references) {
      const row = byId.get(JSON.stringify([ref.scopeId, ref.id]));
      if (!row || ref.version !== undefined && row.version !== ref.version) { unavailable.push(ref); continue; }
      const value = JSON.parse(row.payload) as LongMemoryRecord;
      const cost = memoryTokens(JSON.stringify(value));
      if (records.length>=input.query.limit || estimatedTokens+cost>input.query.tokenBudget) {
        unavailable.push(ref);
        omitted.set(JSON.stringify(['record', ref.scopeId, ref.id, ref.version]), { ...ref, kind: 'record', reason: records.length >= input.query.limit ? 'record_limit' : 'token_budget', estimatedTokens: cost });
        continue;
      }
      records.push(value); estimatedTokens+=cost;
      if (input.includeSources) for (const dependency of value.dependencies) {
        if (dependency.kind!=='source') continue;
        const source = this.store.source(value.scopeId,dependency.id,dependency.version);
        if (!source || sources.has(`${value.scopeId}:${dependency.id}:${dependency.version}`)) continue;
        const original = JSON.parse(source.payload) as LongMemorySource, size = memoryTokens(JSON.stringify(original));
        if (estimatedTokens+size>input.query.tokenBudget) {
          omitted.set(JSON.stringify(['source', value.scopeId, dependency.id, dependency.version]), { kind: 'source', scopeId: value.scopeId, id: dependency.id, version: dependency.version, reason: 'token_budget', estimatedTokens: size });
          continue;
        }
        sources.set(`${value.scopeId}:${dependency.id}:${dependency.version}`,original); estimatedTokens+=size;
      }
    }
    return { records,sources:[...sources.values()],unavailable,estimatedTokens, ...(omitted.size ? { omitted: [...omitted.values()], truncated: true } : {}) };
  }

  graph(input: { scope: LongMemoryScope; id: string; version?: number; limit?: number }): LongMemoryGraph {
    const { scope, id, version } = input, limit = input.limit ?? 40;
    this.store.state(scope);
    if (typeof id !== 'string' || !id || id.length > 512 || !Number.isSafeInteger(limit) || limit < 3 || limit > 100
      || version !== undefined && (!Number.isSafeInteger(version) || version < 1)) invalid('记忆关系图的编号、修订或数量无效。');
    const row = this.store.record(scope.id, id, version);
    if (!row) invalid('记忆已删除或不存在，请刷新列表。');
    const record = JSON.parse(row.payload) as LongMemoryRecord;
    const root = `record:${id}@${record.version}`;
    const recordNode = (value: LongMemoryRecord, side: LongMemoryGraphNode['side']): LongMemoryGraphNode => ({
      key: `record:${value.id}@${value.version}`, id: value.id, scopeId: scope.id, version: value.version,
      type: 'record', side, kind: value.kind, confidence: value.confidence, title: value.topic.at(-1) || value.kind, preview: value.text.slice(0, 180), active: false,
    });
    const nodes: LongMemoryGraphNode[] = [recordNode(record, 'selected')], edges: LongMemoryGraph['edges'] = [];
    // 保留左右两侧的空间；某侧条目少时，将剩余位置交给另一侧。
    const dependents = this.store.db.prepare(`SELECT r.* FROM long_memory_records r JOIN long_memory_dependencies d ON d.record_row=r.row_id
      WHERE r.scope_id=? AND d.parent_kind='record' AND d.parent_id=? AND d.parent_version=?
        AND r.version=(SELECT max(v.version) FROM long_memory_records v WHERE v.scope_id=r.scope_id AND v.id=r.id)
      ORDER BY r.recorded_at DESC,r.id LIMIT ?`).all(scope.id, id, record.version, limit) as RecordRow[];
    const dependencyLimit = Math.max(Math.ceil((limit - 1) / 2), limit - 1 - dependents.length);
    let truncated = record.dependencies.length > dependencyLimit;
    for (const ref of record.dependencies.slice(0, dependencyLimit)) {
      if (ref.kind === 'source') {
        const source = this.store.source(scope.id, ref.id, ref.version); if (!source) continue;
        const value = JSON.parse(source.payload) as LongMemorySource;
        const node: LongMemoryGraphNode = { key: `source:${value.id}@${value.version}`, id: value.id, scopeId: scope.id, version: value.version,
          type: 'source', side: 'dependency', title: value.reference?.label || '来源摘录', preview: value.text.slice(0, 180), kind: value.origin,
          active: this.store.source(scope.id, ref.id)?.version === ref.version };
        nodes.push(node); edges.push({ from: node.key, to: root });
      } else {
        const parent = this.store.record(scope.id, ref.id, ref.version); if (!parent) continue;
        const node = recordNode(JSON.parse(parent.payload), 'dependency'); nodes.push(node); edges.push({ from: node.key, to: root });
      }
    }
    const remaining = limit - nodes.length;
    // 也显示已经失效的最新摘要，让用户能够理解修订影响，而不是把关系静默隐藏。
    if (dependents.length > remaining) truncated = true;
    for (const child of dependents.slice(0, remaining)) {
      const node = recordNode(JSON.parse(child.payload), 'dependent'); nodes.push(node); edges.push({ from: root, to: node.key });
    }
    const ids = [...new Set(nodes.filter(node => node.type === 'record').map(node => node.id))], now = Date.now();
    const { cte, parameters } = this.plan({ scopes: [scope], asOf: now, knownAt: now, limit: 100, tokenBudget: 32000 });
    const active = new Set((this.store.db.prepare(`${cte} SELECT r.id,r.version FROM eligible r WHERE r.id IN(${ids.map(() => '?').join(',')})`)
      .all(...parameters, ...ids) as Array<{ id: string; version: number }>).map(item => `record:${item.id}@${item.version}`));
    for (const node of nodes) if (node.type === 'record') node.active = active.has(node.key);
    return { root, nodes, edges, truncated };
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
