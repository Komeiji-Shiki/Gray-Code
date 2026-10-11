import { createHash } from 'node:crypto';
import type { LongMemoryConfidence, PlatformMessage } from '@graycode/contracts';
import { sourceMessageOrigin } from '../memory/longTerm/content';
import { isHistoricalUserInput } from './retention';
import { CONTEXT_TEXT_FORMAT, contextMessageText, legacyContextMessageText } from './textPage';
import { ToolSchemaValidators } from '../../../../packages/core/src/runtime/toolSchemaValidation';
import { NOTE_ENTRY_SCHEMA, NOTE_KINDS, NOTE_RELATIONS } from './noteSchema';

export { NOTE_KINDS, NOTE_RELATIONS } from './noteSchema';
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
  version: 1 | 2; anchorMessageId: string; inputHash: string; recordedAt: number;
  /** 来源偏移所用的文本视图版本；旧回执没有此字段，偏移按旧版文本计算。 */
  textFormat?: number;
  records: Array<{ id: string; key: string; sources: NoteSource[]; index?: number; relations?: NoteRelation[] }>;
}
export interface NoteEntryError { index: number; key?: string; error: string }
export interface ContextNote {
  id: string; key: string; kind: NoteKind; text: string; about: string[]; relations: NoteRelation[];
  sources: NoteSource[]; recordedAt: number; validFrom: number; validTo?: number; eventAt?: number;
  origin: 'user' | 'model' | 'tool' | 'fiction'; confidence: LongMemoryConfidence; anchorMessageId: string; resultMessageId: string;
}
export type NoteState = 'current' | 'superseded' | 'outside_time' | 'source_unavailable';
export interface ContextNoteGraph {
  notes: Map<string, ContextNote>; states: Map<string, NoteState>; replacements: Map<string, string[]>;
  keys: Map<string, string[]>;
  asOf: number; knownAt: number;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceDigest = (message: PlatformMessage) => digest([message.role, message.parts]);
const noteEntryValidator = new ToolSchemaValidators().compile(NOTE_ENTRY_SCHEMA);
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

function parseNoteEntry(value: unknown, validate = true): NoteEntry {
  const item = validate ? noteEntryValidator.normalizeArguments(object(value)) : object(value);
  if (validate && !noteEntryValidator.validate(item)) {
    const error = noteEntryValidator.validate.errors![0];
    throw new Error(`${error.instancePath || '条目'} ${error.message}`);
  }
  const key = text(item.key, 'key', 80);
  if (key.startsWith('@')) throw new Error('key 不能以 @ 开头。');
  if (!NOTE_KINDS.includes(item.kind as NoteKind)) throw new Error('笔记 kind 无效。');
  let previousMessageId: string | undefined;
  const sources = array(item.sources, 'sources', 8).map(value => {
    const source = object(value);
    if (source.messageId == null && !previousMessageId) throw new Error('sources 首项必须提供 messageId；后续项可省略并沿用上一项。');
    previousMessageId = text(source.messageId ?? previousMessageId, 'messageId', 200);
    return { messageId: previousMessageId,
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
}

/** 旧回执按原来的整批解析规则重放，避免新增的 schema 约束改变历史指纹。 */
export function parseNoteEntries(value: unknown): NoteEntry[] {
  const values = array(value, 'entries', 32);
  if (!values.length) throw new Error('至少需要一条笔记。');
  const keys = new Set<string>();
  return values.map(value => {
    const entry = parseNoteEntry(value, false);
    if (keys.has(entry.key)) throw new Error('同批 key 必须唯一。');
    keys.add(entry.key);
    return entry;
  });
}

export function noteQueryTime(value: unknown, fallback: number): number { return time(value, '查询时间') ?? fallback; }

const TOOL_SOURCE_PREFIX = 'tool:';
const hasToolResult = (message: PlatformMessage, callId?: string) => message.parts.some(part => {
  const response = part.functionResponse as { id?: string } | undefined;
  return !!response && (callId === undefined || response.id === callId);
});

/**
 * 来源别名只在记录时解析为真实消息 ID，回执里保存的始终是具体消息。
 * 工具结果消息的 ID 不会出现在模型可见的内容里，所以提供 last_tool_result 与 tool:<调用 ID>。
 */
function resolveSourceMessage(reference: string, messages: PlatformMessage[], byId: Map<string | undefined, PlatformMessage>, anchor: PlatformMessage) {
  if (reference === 'last_user') return messages.findLast(isHistoricalUserInput);
  if (reference === 'last_assistant') return messages.findLast(message => message.role === 'model' && message !== anchor
    && message.parts.some(part => !part.thought && typeof part.text === 'string'));
  if (reference === 'last_tool_result') return messages.findLast(message => message !== anchor && hasToolResult(message));
  if (reference.startsWith(TOOL_SOURCE_PREFIX) && reference.length > TOOL_SOURCE_PREFIX.length)
    return messages.findLast(message => hasToolResult(message, reference.slice(TOOL_SOURCE_PREFIX.length)));
  return byId.get(reference);
}

export function recordContextNotes(messages: PlatformMessage[], toolCallId: string | undefined, value: unknown, now = Date.now()) {
  const values = array(value, 'entries', 32);
  if (!values.length) throw new Error('至少需要一条笔记。');
  const anchor = messages.findLast(message => message.role === 'model' && message.parts.some(part => {
    const call = part.functionCall as { id?: string; name?: string } | undefined;
    return call?.id === toolCallId && call?.name === 'context_notes';
  }));
  if (!toolCallId || !anchor?.id) throw new Error('笔记记录缺少当前已保存的工具调用。');
  const previous = buildNoteGraph(messages, now, now);
  const byId = new Map(messages.map(message => [message.id, message]));
  const sourceTexts = new Map<string, string>(), sourceDigests = new Map<string, string>();
  const keys = values.map(value => value && typeof value === 'object' && 'key' in value && typeof value.key === 'string'
    ? value.key.trim() : undefined);
  const keyCounts = new Map<string, number>();
  for (const key of keys) if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  // 无效条目的 key 也占用本批引用，避免引用失败项时意外连到历史中的同名笔记。
  const localIds = new Map([...keyCounts.keys()].map(key => [key, `note_${digest([anchor.id, toolCallId, key]).slice(0, 24)}`]));
  const errors = new Map<number, NoteEntryError>();
  const accepted = new Map<string, { entry: NoteEntry; record: NoteReceipt['records'][number] }>();
  const reject = (index: number, error: string) => errors.set(index, { index, ...(keys[index] ? { key: keys[index] } : {}), error });
  const resolveTarget = (reference: string) => {
    if (previous.notes.has(reference)) return reference;
    const key = reference.startsWith('@') ? reference.slice(1) : reference;
    return localIds.get(key) ?? resolveNoteReference(previous, key);
  };
  values.forEach((value, index) => {
    try {
      const entry = parseNoteEntry(value);
      if (keyCounts.get(entry.key)! > 1) throw new Error('同批 key 必须唯一；请为重复条目使用不同 key。');
      if (entry.validTo !== undefined && entry.validTo <= (entry.validFrom ?? now)) throw new Error('validTo 必须晚于 validFrom。');
      const id = localIds.get(entry.key)!;
      const relations = entry.relations.map(relation => {
        const target = resolveTarget(relation.target);
        if (!target || previous.states.get(target) === 'source_unavailable') {
          throw new Error(`关系目标 ${relation.target} 不在当前分支的有效笔记中。`);
        }
        if (target === id) throw new Error('笔记不能关联自身。');
        return { ...relation, target };
      });
      if (entry.kind === 'state') {
        const replacedId = resolveNoteReference(previous, `@${entry.key}`);
        if (replacedId) {
          if (previous.notes.get(replacedId)!.kind !== 'state') throw new Error(`key ${entry.key} 已被其他类型的笔记使用，请为状态选择独立 key。`);
          if (!relations.some(relation => relation.kind === 'supersedes' && relation.target === replacedId)) {
            relations.push({ kind: 'supersedes', target: replacedId });
          }
        }
      }
      const sources = entry.sources.map(source => {
        const message = resolveSourceMessage(source.messageId, messages, byId, anchor);
        if (!message?.id || message.memoryRedacted || message === anchor) throw new Error(`来源 ${source.messageId} 不在当前可读的历史中。`);
        // 同批笔记经常共用一个来源，完整工具结果的正文和指纹只计算一次。
        if (!sourceTexts.has(message.id)) sourceTexts.set(message.id, contextMessageText(message));
        if (!sourceDigests.has(message.id)) sourceDigests.set(message.id, sourceDigest(message));
        const body = sourceTexts.get(message.id)!;
        const offset = source.quote === undefined ? undefined : body.indexOf(source.quote);
        if (offset === -1) throw new Error(`来源摘录必须逐字来自消息 ${message.id}。`);
        if (source.quote !== undefined && body.indexOf(source.quote, offset! + 1) !== -1) throw new Error('来源摘录出现多次，请提供更完整、唯一的片段。');
        return { messageId: message.id, digest: sourceDigests.get(message.id)!,
          ...(offset === undefined ? {} : { offset, length: source.quote!.length }) };
      });
      accepted.set(id, { entry, record: { id, key: entry.key, index, sources, relations } });
    } catch (error) {
      reject(index, error instanceof Error ? error.message : String(error));
    }
  });
  // 仅拒绝替代循环本身及引用失败项的条目，保留与它们无关的有效记录。
  const checked = new Set<string>(), cyclic = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const start = path.indexOf(id);
    if (start !== -1) { for (const member of path.slice(start)) cyclic.add(member); return; }
    if (checked.has(id)) return;
    for (const relation of accepted.get(id)?.record.relations ?? []) {
      if (relation.kind === 'supersedes') visit(relation.target, [...path, id]);
    }
    checked.add(id);
  };
  for (const id of accepted.keys()) visit(id, []);
  for (const id of cyclic) {
    reject(accepted.get(id)!.record.index!, 'supersedes 不能形成循环。');
    accepted.delete(id);
  }
  const localTargets = new Set(localIds.values());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, candidate] of accepted) {
      const missing = candidate.record.relations!.find(relation => localTargets.has(relation.target) && !accepted.has(relation.target));
      if (!missing) continue;
      const targetKey = [...localIds].find(([, target]) => target === missing.target)![0];
      reject(candidate.record.index!, `本批关系目标 ${targetKey} 未保存，请先修正该条目。`);
      accepted.delete(id);
      changed = true;
    }
  }
  const candidates = [...accepted.values()];
  const receipt: NoteReceipt = {
    version: 2, anchorMessageId: anchor.id, inputHash: digest(candidates.map(candidate => candidate.entry)),
    recordedAt: now, textFormat: CONTEXT_TEXT_FORMAT, records: candidates.map(candidate => candidate.record),
  };
  return {
    success: candidates.length > 0,
    partial: candidates.length > 0 && errors.size > 0,
    recordedCount: candidates.length,
    failedCount: errors.size,
    errors: [...errors.values()].sort((a, b) => a.index - b.index),
    ...(candidates.length ? { noteEvent: receipt } : { error: '本批没有保存任何笔记，请按 errors 修正失败条目。' }),
  };
}

/**
 * 旧回执的偏移按旧版文本（工具结果为整段 JSON）计算。纯文字消息两版一致，直接沿用；
 * 含工具结果的消息按旧文本取出摘录，在当前文本中唯一出现时换算位置，否则去掉偏移，
 * 来源仍由消息指纹保证可追溯，只是不再给出可能错位的续读位置。
 */
function remapLegacySource(source: NoteSource, message: PlatformMessage | undefined, currentText: (message: PlatformMessage) => string,
  legacyTexts: Map<string, string>): NoteSource {
  if (source.offset === undefined || source.length === undefined || !message?.id) return source;
  if (!message.parts.some(part => part.functionResponse)) return source;
  if (!legacyTexts.has(message.id)) legacyTexts.set(message.id, legacyContextMessageText(message));
  const quote = legacyTexts.get(message.id)!.slice(source.offset, source.offset + source.length);
  const body = currentText(message);
  const offset = quote.length === source.length ? body.indexOf(quote) : -1;
  const { offset: _offset, length: _length, ...rest } = source;
  if (offset === -1 || body.indexOf(quote, offset + 1) !== -1) return rest;
  return { ...rest, offset, length: source.length };
}

/**
 * 中间版本的文本视图不再保留生成方式，无法可靠取回旧摘录。工具结果来源去掉偏移，
 * 纯文字消息各版本一致，偏移照旧可用；来源是否可追溯仍由消息指纹判断。
 */
function withoutStaleToolOffset(source: NoteSource, message: PlatformMessage | undefined): NoteSource {
  if (source.offset === undefined || !message?.parts.some(part => part.functionResponse)) return source;
  const { offset: _offset, length: _length, ...rest } = source;
  return rest;
}

/** 仅重放当前分支里成功的工具结果；取消、失败和其他分支的调用不会产生图节点。 */
export function buildNoteGraph(messages: PlatformMessage[], asOf = Date.now(), knownAt = asOf): ContextNoteGraph {
  const notes = new Map<string, ContextNote>(), states = new Map<string, NoteState>();
  const byId = new Map(messages.map(message => [message.id, message]));
  const calls = new Map<string, { message: PlatformMessage; entries: unknown }>();
  const fingerprints = new Map<string, string>();
  const sourceTexts = new Map<string, string>();
  const sourceText = (message: PlatformMessage) => {
    if (!sourceTexts.has(message.id!)) sourceTexts.set(message.id!, contextMessageText(message));
    return sourceTexts.get(message.id!)!;
  };
  const legacyTexts = new Map<string, string>();
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
      if (!message.id || message.memoryRedacted || response?.name !== 'context_notes' || response.response?.success !== true
        || !receipt || ![1, 2].includes(receipt.version)) continue;
      const original = calls.get(response.id!);
      if (!original || original.message.id !== receipt.anchorMessageId || original.message.memoryRedacted) continue;
      let entries: NoteEntry[];
      try {
        if (receipt.version === 1) entries = parseNoteEntries(original.entries);
        else {
          const values = array(original.entries, 'entries', 32);
          entries = receipt.records.map(record => {
            if (!Number.isInteger(record.index) || record.index! < 0 || record.index! >= values.length || !record.relations) {
              throw new Error('笔记回执缺少有效的条目位置或关系。');
            }
            return parseNoteEntry(values[record.index!]);
          });
        }
      } catch { continue; }
      if (digest(entries) !== receipt.inputHash || entries.length !== receipt.records.length) continue;
      const localIds = new Map(receipt.records.map(record => [record.key, record.id]));
      entries.forEach((entry, index) => {
        const record = receipt.records[index];
        if (record.key !== entry.key) return;
        const sourceMessages = record.sources.map(source => byId.get(source.messageId));
        const sources = receipt.textFormat === CONTEXT_TEXT_FORMAT ? record.sources
          : receipt.textFormat === undefined
            ? record.sources.map((source, index) => remapLegacySource(source, sourceMessages[index], sourceText, legacyTexts))
            : record.sources.map((source, index) => withoutStaleToolOffset(source, sourceMessages[index]));
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
        const confidence = origin !== 'model' && origin !== 'fiction' && sourceMessages.some(source => source && sourceText(source).includes(entry.text))
          ? 'confirmed' : 'inferred';
        const node: ContextNote = { id: record.id, key: entry.key, kind: entry.kind, text: entry.text, about: entry.about,
          relations: receipt.version === 2 ? record.relations! : entry.relations.map(relation => ({
            ...relation, target: relation.target.startsWith('@') ? localIds.get(relation.target.slice(1))! : relation.target,
          })),
          sources, origin, confidence, recordedAt: receipt.recordedAt, validFrom: entry.validFrom ?? receipt.recordedAt,
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
  const keys = new Map<string, string[]>();
  for (const note of notes.values()) keys.set(note.key, [...keys.get(note.key) ?? [], note.id]);
  return { notes, states, replacements, keys, asOf, knownAt };
}

/** 一个旧决定可以有多个并行修订；返回所有有效候选，让模型看到分歧而非按时间猜一个。 */
export function currentNoteIds(graph: ContextNoteGraph, id: string, visited = new Set<string>()): string[] {
  if (visited.has(id)) return [];
  if (graph.states.get(id) === 'current') return [id];
  if (graph.states.get(id) !== 'superseded') return [];
  return [...new Set((graph.replacements.get(id) ?? []).flatMap(next => currentNoteIds(graph, next, new Set([...visited, id]))))];
}

/** ID 精确读取历史；key 沿替代关系找到有效版本，重名时明确返回候选而不猜测。 */
export function resolveNoteReference(graph: ContextNoteGraph, reference: string): string | undefined {
  if (graph.notes.has(reference)) return reference;
  const key = reference.startsWith('@') ? reference.slice(1) : reference;
  const candidates = [...new Set((graph.keys.get(key) ?? []).flatMap(id => currentNoteIds(graph, id)))];
  if (candidates.length > 1) throw new Error(`笔记 key ${key} 有多个有效候选，请使用笔记 ID：${candidates.join('、')}。`);
  return candidates[0];
}

export function noteDetails(note: ContextNote, state: NoteState | undefined) {
  return { id: note.id, key: note.key, kind: note.kind, text: note.text, about: note.about, state, origin: note.origin, confidence: note.confidence,
    recordedAt: note.recordedAt, validFrom: note.validFrom, validTo: note.validTo, eventAt: note.eventAt,
    relations: note.relations, sources: note.sources.map(({ digest: _digest, ...source }) => source),
    resultMessageId: note.resultMessageId };
}
