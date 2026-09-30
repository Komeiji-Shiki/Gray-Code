import type { PlatformMessage } from '@graycode/contracts';
import { memoryTokens as estimateMemoryTokens, memoryTerms as memorySearchTerms } from '../../../../packages/core/src/storage/longMemory/text';
import { currentNoteIds, noteDetails, type ContextNote, type ContextNoteGraph } from './noteGraph';
import { isHistoricalUserInput } from './retention';

export interface NoteRecallOptions {
  query?: string; ids?: string[]; taskId?: string; tokenBudget: number; limit?: number;
  asOf?: number; knownAt?: number;
}
interface RecallReceipt { version: 1; windowId: string; stageId: string; timeKey: string; ids: string[] }
interface Candidate { note: ContextNote; score: number; priority: number; via?: { id: string; relation: string } }

function recallStage(messages: PlatformMessage[], options: NoteRecallOptions) {
  const windowId = messages.findLast(message => typeof message.contextWindowId === 'string')?.contextWindowId as string | undefined;
  const stageId = options.taskId ?? messages.findLast(isHistoricalUserInput)?.id ?? 'initial';
  return { windowId: windowId ?? 'initial', stageId, timeKey: JSON.stringify([options.asOf ?? null, options.knownAt ?? null]) };
}

/** 已返回的工具结果就是召回快照；去重状态随历史和分支恢复，不另写会随查询变化的缓存。 */
interface ProvidedNote { messageId: string; reason: 'recorded' | 'recalled' | 'verbatim' }
function providedNotes(messages: PlatformMessage[], notes: ContextNote[]): Map<string, ProvidedNote> {
  const result = new Map<string, ProvidedNote>();
  const pending = new Map(notes.map(note => [note.id, note]));
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  for (const message of messages) {
    if (!message.id || message.isSummarized || message.memoryRedacted) continue;
    for (const part of message.parts) {
      if (part.thought) continue;
      const response = part.functionResponse as { name?: string; response?: { success?: boolean; noteRecall?: RecallReceipt } } | undefined;
      const receipt = response?.response?.noteRecall;
      if (response?.name === 'context_notes' && response.response?.success === true && receipt?.version === 1)
        for (const id of receipt.ids) { result.set(id, { messageId: message.id, reason: 'recalled' }); pending.delete(id); }
      // 正文已经找到后无需继续展开大段工具参数；后续召回回执仍更新历史位置。
      if (!pending.size) continue;
      const bodies = typeof part.text === 'string' ? [part.text]
        : part.functionCall ? strings((part.functionCall as { args?: unknown }).args)
          : part.functionResponse ? strings((part.functionResponse as { response?: unknown }).response) : [];
      for (const note of pending.values()) if (bodies.some(body => body.includes(note.text))) {
        result.set(note.id, { messageId: message.id, reason: message.id === note.anchorMessageId ? 'recorded' : 'verbatim' });
        pending.delete(note.id);
      }
    }
  }
  return result;
}

/** 先找到任务起点，再沿有方向的依据关系读取；词汇分数只负责定位，不冒充语义置信度。 */
export function recallContextNotes(graph: ContextNoteGraph, messages: PlatformMessage[], options: NoteRecallOptions, visibleMessages: PlatformMessage[]) {
  const stage = recallStage(messages, options);
  const terms = [...new Set(memorySearchTerms(options.query ?? ''))];
  const current = [...graph.notes.values()].filter(note => graph.states.get(note.id) === 'current');
  const termSets = new Map(terms.length ? current.map(note => [note.id, new Set(memorySearchTerms(`${note.text}\n${note.about.join(' ')}`))] as const) : []);
  const frequencies = new Map(terms.map(term => [term, current.filter(note => termSets.get(note.id)!.has(term)).length]));
  const lexicalScore = (note: ContextNote) => terms.reduce((score, term) => score + (termSets.get(note.id)!.has(term)
    ? Math.log(1 + current.length / (1 + frequencies.get(term)!)) : 0), 0);
  const candidates = new Map<string, Candidate>(), unavailable = new Set<string>(), required = new Set<string>();
  const redirected = new Map<string, string[]>();
  let traversalTruncated = false;
  const queue: string[] = [];
  const add = (id: string, score: number, priority: number, via?: Candidate['via']) => {
    const resolved = currentNoteIds(graph, id);
    if (!resolved.length) { unavailable.add(id); if (via?.relation === 'requires') required.add(id); return; }
    if (resolved.length !== 1 || resolved[0] !== id) redirected.set(id, resolved);
    for (const target of resolved) {
      const previous = candidates.get(target);
      if (!previous) {
        if (candidates.size >= 256) {
          traversalTruncated = true; unavailable.add(target);
          if (via?.relation === 'requires') required.add(target);
          continue;
        }
        candidates.set(target, { note: graph.notes.get(target)!, score, priority, via }); queue.push(target);
      } else if (priority > previous.priority || priority === previous.priority && score > previous.score) {
        candidates.set(target, { ...previous, score, priority, via });
      }
      if (via?.relation === 'requires') required.add(target);
    }
  };
  const requested = [...new Set([...(options.ids ?? []), ...(options.taskId ? [options.taskId] : [])])];
  for (const id of requested) add(id, Number.MAX_SAFE_INTEGER, 4);
  if (terms.length) {
    const ranked = current.map(note => ({ note, score: lexicalScore(note) })).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.note.recordedAt - a.note.recordedAt || a.note.id.localeCompare(b.note.id));
    for (const item of ranked.slice(0, 12)) add(item.note.id, item.score, 2);
  } else if (!requested.length) {
    for (const note of [...current].sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id)).slice(0, 12)) add(note.id, 1, 2);
  }
  const incoming = new Map<string, Array<{ note: ContextNote; kind: string }>>();
  for (const note of current) for (const relation of note.relations) {
    if (!['supports', 'applies_to', 'contradicts'].includes(relation.kind)) continue;
    for (const target of currentNoteIds(graph, relation.target)) {
      const edges = incoming.get(target) ?? [];
      edges.push({ note, kind: relation.kind }); incoming.set(target, edges);
    }
  }
  const traversed = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (traversed.has(id)) continue;
    traversed.add(id);
    const candidate = candidates.get(id)!;
    for (const relation of candidate.note.relations) {
      if (relation.kind === 'requires') add(relation.target, candidate.score, 5, { id, relation: 'requires' });
      else if (relation.kind === 'contradicts') add(relation.target, candidate.score / 2, 3, { id, relation: 'contradicts' });
    }
    for (const edge of incoming.get(id) ?? []) {
      const priority = edge.kind === 'applies_to' && edge.note.kind === 'constraint' ? 5 : 3;
      add(edge.note.id, candidate.score / 2, priority, { id, relation: edge.kind });
    }
  }
  const limit = Math.min(50, options.limit ?? 15);
  const ordered = [...candidates.values()].sort((a, b) => b.priority - a.priority || b.score - a.score
    || estimateMemoryTokens(a.note.text) - estimateMemoryTokens(b.note.text) || a.note.id.localeCompare(b.note.id));
  const provided = providedNotes(visibleMessages, ordered.map(candidate => candidate.note));
  const result = {
    success: true, asOf: graph.asOf, knownAt: graph.knownAt,
    items: [] as Array<ReturnType<typeof noteDetails> & { via?: Candidate['via'] }>,
    alreadyProvided: [] as Array<{ id: string } & ProvidedNote>,
    omitted: [] as string[], unavailable: [] as string[], missingDependencies: [] as string[],
    replacements: [] as Array<{ id: string; currentIds: string[] }>,
    candidateCount: candidates.size, currentCount: current.length, truncated: traversalTruncated,
    estimatedTokens: 0, tokenBudget: options.tokenBudget,
    noteRecall: { version: 1 as const, ...stage, ids: [] as string[] },
  };
  // 将回执、引用与省略说明也计入同一预算；不截断陈述，以免丢失条件或否定词。
  const cost = () => {
    let measured = estimateMemoryTokens(JSON.stringify(result));
    while (measured !== result.estimatedTokens) {
      result.estimatedTokens = measured;
      measured = estimateMemoryTokens(JSON.stringify(result));
    }
    return measured;
  };
  if (cost() > options.tokenBudget) return { success: false, error: '预算不足以容纳当前查询的引用信息。', requiredTokenBudget: cost() };
  const fit = <T>(list: T[], item: T): boolean => {
    list.push(item);
    if (cost() <= options.tokenBudget) return true;
    list.pop(); result.truncated = true; return false;
  };
  for (const [id, currentIds] of redirected) fit(result.replacements, { id, currentIds });
  for (const id of unavailable) fit(result.unavailable, id);
  const delivered = new Set<string>();
  for (const candidate of ordered) {
    const { note } = candidate;
    const prior = provided.get(note.id);
    if (prior) {
      if (fit(result.alreadyProvided, { id: note.id, ...prior })) delivered.add(note.id);
      continue;
    }
    if (result.items.length >= limit) { result.truncated = true; continue; }
    result.noteRecall.ids.push(note.id);
    if (fit(result.items, { ...noteDetails(note, 'current'), ...(candidate.via ? { via: candidate.via } : {}) })) delivered.add(note.id);
    else result.noteRecall.ids.pop();
  }
  for (const id of required) if (!delivered.has(id)) { result.truncated = true; fit(result.missingDependencies, id); }
  for (const id of candidates.keys()) if (!delivered.has(id)) { result.truncated = true; fit(result.omitted, id); }
  cost();
  return result;
}
