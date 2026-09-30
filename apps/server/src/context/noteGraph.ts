import { createHash } from 'node:crypto';
import type { LongMemoryConfidence, PlatformMessage } from '@graycode/contracts';
import { sourceMessageOrigin } from '../memory/longTerm/content';
import { isHistoricalUserInput } from './retention';
import { contextMessageText } from './textPage';

export const NOTE_KINDS = ['constraint', 'decision', 'observation', 'hypothesis', 'task', 'lesson'] as const;
export const NOTE_RELATIONS = ['requires', 'supports', 'contradicts', 'applies_to', 'supersedes'] as const;
type NoteKind = typeof NOTE_KINDS[number];
type RelationKind = typeof NOTE_RELATIONS[number];
export interface NoteRelation { kind: RelationKind; target: string }
interface NoteSourceInput { messageId: string; quote?: string }
export interface NoteEntry {
  key: string; kind: NoteKind; text: string; about: string[]; sources: NoteSourceInput[];
  relations: NoteRelation[]; validFrom?: number; validTo?: number; eventAt?: number;
}
export interface NoteSource { messageId: string; digest: string; offset?: number; length?: number }
export interface NoteReceipt {
  version: 1; anchorMessageId: string; inputHash: string; recordedAt: number;
  records: Array<{ id: string; key: string; sources: NoteSource[] }>;
}
export interface ContextNote {
  id: string; kind: NoteKind; text: string; about: string[]; relations: NoteRelation[];
  sources: NoteSource[]; recordedAt: number; validFrom: number; validTo?: number; eventAt?: number;
  origin: 'user' | 'model' | 'tool' | 'fiction'; confidence: LongMemoryConfidence; anchorMessageId: string; resultMessageId: string;
}
export type NoteState = 'current' | 'superseded' | 'outside_time' | 'source_unavailable';
export interface ContextNoteGraph {
  notes: Map<string, ContextNote>; states: Map<string, NoteState>; replacements: Map<string, string[]>;
  asOf: number; knownAt: number;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceDigest = (message: PlatformMessage) => digest([message.role, message.parts]);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('笔记条目必须是对象。');
  return value as Record<string, unknown>;
};
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}需要非空文字，最多 ${max} 字符。`);
  return value.trim();
}
function time(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error(`${label}必须是 UTC Unix 毫秒。`);
  return Number(value);
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}必须是数组，最多 ${max} 项。`);
  return value;
}

/** 调用与回执共同构成事件；正文只保存在调用参数里，回执不重复整份笔记。 */
export function parseNoteEntries(value: unknown): NoteEntry[] {
  const values = array(value, 'entries', 32);
  if (!values.length) throw new Error('至少需要一条笔记。');
  const keys = new Set<string>();
  return values.map(value => {
    const item = object(value), key = text(item.key, 'key', 80);
    if (key.startsWith('@') || keys.has(key)) throw new Error('同批 key 必须唯一，且不能以 @ 开头。');
    keys.add(key);
    if (!NOTE_KINDS.includes(item.kind as NoteKind)) throw new Error('笔记 kind 无效。');
    const sources = array(item.sources, 'sources', 8).map(value => {
      const source = object(value);
      return { messageId: text(source.messageId, 'messageId', 200),
        ...(source.quote == null ? {} : { quote: text(source.quote, 'quote', 4000) }) };
    });
    if (!sources.length) throw new Error('每条笔记必须引用真实历史来源。');
    const relations = array(item.relations ?? [], 'relations', 32).map(value => {
      const relation = object(value);
      if (!NOTE_RELATIONS.includes(relation.kind as RelationKind)) throw new Error('笔记关系 kind 无效。');
      return { kind: relation.kind as RelationKind, target: text(relation.target, 'target', 200) };
    });
    const validFrom = time(item.validFrom, 'validFrom'), validTo = time(item.validTo, 'validTo');
    if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) throw new Error('validTo 必须晚于 validFrom。');
    return { key, kind: item.kind as NoteKind, text: text(item.text, 'text', 4000),
      about: [...new Set(array(item.about ?? [], 'about', 16).map(value => text(value, 'about', 200)))],
      sources, relations, validFrom, validTo, eventAt: time(item.eventAt, 'eventAt') };
  });
}

export function noteQueryTime(value: unknown, fallback: number): number { return time(value, '查询时间') ?? fallback; }

export function createNoteReceipt(messages: PlatformMessage[], toolCallId: string | undefined, entries: NoteEntry[], now = Date.now()): NoteReceipt {
  const anchor = messages.findLast(message => message.role === 'model' && message.parts.some(part => {
    const call = part.functionCall as { id?: string; name?: string } | undefined;
    return call?.id === toolCallId && call?.name === 'context_notes';
  }));
  if (!toolCallId || !anchor?.id) throw new Error('笔记记录缺少当前已保存的工具调用。');
  const previous = buildNoteGraph(messages, now, now);
  const byId = new Map(messages.map(message => [message.id, message]));
  const localIds = new Map(entries.map(entry => [entry.key, `note_${digest([anchor.id, toolCallId, entry.key]).slice(0, 24)}`]));
  const resolveTarget = (target: string) => target.startsWith('@') ? localIds.get(target.slice(1)) : previous.notes.has(target) ? target : undefined;
  const records = entries.map(entry => {
    if (entry.validTo !== undefined && entry.validTo <= (entry.validFrom ?? now)) throw new Error('validTo 必须晚于 validFrom。');
    for (const relation of entry.relations) {
      const target = resolveTarget(relation.target);
      if (!target || previous.states.get(target) === 'source_unavailable') throw new Error(`关系目标 ${relation.target} 不在当前分支的有效笔记中。`);
      if (target === localIds.get(entry.key)) throw new Error('笔记不能关联自身。');
    }
    const sources = entry.sources.map(source => {
      const message = source.messageId === 'last_user' ? messages.findLast(isHistoricalUserInput)
        : source.messageId === 'last_assistant' ? messages.findLast(message => message.role === 'model' && message !== anchor
          && message.parts.some(part => !part.thought && typeof part.text === 'string')) : byId.get(source.messageId);
      if (!message?.id || message.memoryRedacted || message === anchor) throw new Error(`来源 ${source.messageId} 不在当前可读的历史中。`);
      const body = contextMessageText(message);
      const offset = source.quote === undefined ? undefined : body.indexOf(source.quote);
      if (offset === -1) throw new Error(`来源摘录必须逐字来自消息 ${message.id}。`);
      if (source.quote !== undefined && body.indexOf(source.quote, offset! + 1) !== -1) throw new Error('来源摘录出现多次，请提供更完整、唯一的片段。');
      return { messageId: message.id, digest: sourceDigest(message),
        ...(offset === undefined ? {} : { offset, length: source.quote!.length }) };
    });
    return { id: localIds.get(entry.key)!, key: entry.key, sources };
  });
  // 批内允许前向引用，但替代关系不能形成循环，否则两条决定会同时消失。
  const supersedes = new Map(entries.map(entry => [localIds.get(entry.key)!, entry.relations
    .filter(relation => relation.kind === 'supersedes').map(relation => resolveTarget(relation.target)!)]));
  const checked = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error('supersedes 不能形成循环。');
    if (checked.has(id)) return;
    for (const target of supersedes.get(id) ?? []) visit(target, new Set([...path, id]));
    checked.add(id);
  };
  for (const id of supersedes.keys()) visit(id, new Set());
  return { version: 1, anchorMessageId: anchor.id, inputHash: digest(entries), recordedAt: now, records };
}

/** 仅重放当前分支里成功的工具结果；取消、失败和其他分支的调用不会产生图节点。 */
export function buildNoteGraph(messages: PlatformMessage[], asOf = Date.now(), knownAt = asOf): ContextNoteGraph {
  const notes = new Map<string, ContextNote>(), states = new Map<string, NoteState>();
  const byId = new Map(messages.map(message => [message.id, message]));
  const calls = new Map<string, { message: PlatformMessage; entries: unknown }>();
  const fingerprints = new Map<string, string>();
  const originsById = new Map<string, ContextNote['origin']>();
  let previousInput: PlatformMessage | undefined;
  for (const message of messages) {
    if (message.isUserInput) previousInput = message;
    if (message.id) originsById.set(message.id, sourceMessageOrigin(message, previousInput ? [previousInput, message] : [message]));
  }
  for (const message of messages) {
    for (const part of message.parts) {
      const call = part.functionCall as { id?: string; name?: string; args?: Record<string, unknown> } | undefined;
      if (message.role === 'model' && call?.id && call.name === 'context_notes' && call.args?.action === 'record')
        calls.set(call.id, { message, entries: call.args.entries });
      const response = part.functionResponse as { id?: string; name?: string; response?: { success?: boolean; noteEvent?: NoteReceipt } } | undefined;
      const receipt = response?.response?.noteEvent;
      if (!message.id || message.memoryRedacted || response?.name !== 'context_notes' || response.response?.success !== true || receipt?.version !== 1) continue;
      const original = calls.get(response.id!);
      if (!original || original.message.id !== receipt.anchorMessageId || original.message.memoryRedacted) continue;
      let entries: NoteEntry[];
      try { entries = parseNoteEntries(original.entries); } catch { continue; }
      if (digest(entries) !== receipt.inputHash || entries.length !== receipt.records.length) continue;
      const localIds = new Map(receipt.records.map(record => [record.key, record.id]));
      entries.forEach((entry, index) => {
        const record = receipt.records[index];
        if (record.key !== entry.key) return;
        const sourceMessages = record.sources.map(source => byId.get(source.messageId));
        const available = record.sources.every((source, index) => {
          const sourceMessage = sourceMessages[index];
          if (!sourceMessage || sourceMessage.memoryRedacted) return false;
          if (!fingerprints.has(source.messageId)) fingerprints.set(source.messageId, sourceDigest(sourceMessage));
          return fingerprints.get(source.messageId) === source.digest;
        });
        const origins = sourceMessages.flatMap(source => source?.id ? [originsById.get(source.id)!] : []);
        const origin = origins.includes('fiction') ? 'fiction' : origins.includes('model') || entry.kind === 'hypothesis' ? 'model'
          : origins.every(origin => origin === 'user') ? 'user' : 'tool';
        // 引用存在只能证明来源可追溯，不能把模型转述提升为用户已确认的原话。
        const confidence = origin !== 'model' && origin !== 'fiction' && sourceMessages.some(source => source && contextMessageText(source).includes(entry.text))
          ? 'confirmed' : 'inferred';
        const node: ContextNote = { id: record.id, kind: entry.kind, text: entry.text, about: entry.about,
          relations: entry.relations.map(relation => ({ ...relation, target: relation.target.startsWith('@') ? localIds.get(relation.target.slice(1))! : relation.target })),
          sources: record.sources, origin, confidence, recordedAt: receipt.recordedAt, validFrom: entry.validFrom ?? receipt.recordedAt,
          validTo: entry.validTo, eventAt: entry.eventAt, anchorMessageId: receipt.anchorMessageId, resultMessageId: message.id! };
        notes.set(node.id, node);
        states.set(node.id, !available ? 'source_unavailable' : node.recordedAt > knownAt || node.validFrom > asOf
          || node.validTo !== undefined && node.validTo <= asOf ? 'outside_time' : 'current');
      });
    }
  }
  const replacements = new Map<string, string[]>();
  for (const node of notes.values()) if (states.get(node.id) === 'current') {
    for (const relation of node.relations) if (relation.kind === 'supersedes' && notes.has(relation.target))
      replacements.set(relation.target, [...replacements.get(relation.target) ?? [], node.id]);
  }
  for (const id of replacements.keys()) if (states.get(id) === 'current') states.set(id, 'superseded');
  return { notes, states, replacements, asOf, knownAt };
}

/** 一个旧决定可以有多个并行修订；返回所有有效候选，让模型看到分歧而非按时间猜一个。 */
export function currentNoteIds(graph: ContextNoteGraph, id: string, visited = new Set<string>()): string[] {
  if (visited.has(id)) return [];
  if (graph.states.get(id) === 'current') return [id];
  if (graph.states.get(id) !== 'superseded') return [];
  return [...new Set((graph.replacements.get(id) ?? []).flatMap(next => currentNoteIds(graph, next, new Set([...visited, id]))))];
}

export function noteDetails(note: ContextNote, state: NoteState | undefined) {
  return { id: note.id, kind: note.kind, text: note.text, about: note.about, state, origin: note.origin, confidence: note.confidence,
    recordedAt: note.recordedAt, validFrom: note.validFrom, validTo: note.validTo, eventAt: note.eventAt,
    relations: note.relations, sources: note.sources.map(({ digest: _digest, ...source }) => source),
    resultMessageId: note.resultMessageId };
}
