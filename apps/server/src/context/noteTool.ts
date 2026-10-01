import type { PlatformMessage } from '@graycode/contracts';
import { buildNoteGraph, createNoteReceipt, NOTE_KINDS, NOTE_RELATIONS, noteDetails, noteQueryTime, parseNoteEntries } from './noteGraph';
import { recallContextNotes, type NoteRecallOptions } from './noteRecall';
import { textPage } from './textPage';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 200 };
const time = { type: 'integer', description: 'UTC Unix 毫秒；没有明确时间依据时省略。' };
export const NOTE_GRAPH_PROPERTIES = {
  entries: { type: 'array', minItems: 1, maxItems: 32, description: '批量记录，key 在本批唯一。关系 target 可引用已返回的笔记 ID，或用 @key 引用本批其他条目。',
    items: object({ key: { type: 'string', minLength: 1, maxLength: 80 }, kind: { type: 'string', enum: NOTE_KINDS },
      text: { type: 'string', minLength: 1, maxLength: 4000, description: '保留条件、否定、决定理由和仍未解决的问题。' },
      about: { type: 'array', maxItems: 16, items: id, description: '相关任务、文件、符号或主题。' },
      sources: { type: 'array', minItems: 1, maxItems: 8, items: object({ messageId: { ...id, description: '真实历史 ID，或 last_user / last_assistant / last_tool_result（最近一条工具结果），或 tool:<工具调用 ID>。' },
        quote: { type: 'string', minLength: 1, maxLength: 4000, description: '可选的唯一原文摘录；返回的偏移可用于 context_history.read。' } }, ['messageId']) },
      relations: { type: 'array', maxItems: 32, items: object({ kind: { type: 'string', enum: NOTE_RELATIONS,
        description: '本条 requires 依赖目标，supports 支持目标，applies_to 适用于目标，contradicts 与目标冲突，supersedes 替代目标。' }, target: id }, ['kind', 'target']) },
      validFrom: time, validTo: time, eventAt: time }, ['key', 'kind', 'text', 'sources']) },
  query: { type: 'string', minLength: 1, maxLength: 1000, description: 'recall 的当前意图；省略并且没有 ids/taskId 时浏览近期有效笔记。' },
  ids: { type: 'array', maxItems: 32, items: id, description: 'recall 的精确起点，旧决定会沿替代关系找到当前版本。' },
  taskId: { ...id, description: 'recall 从这条任务笔记补齐依赖、约束和依据。' },
  noteId: { ...id, description: 'inspect 读取一条笔记，已召回过也会明确返回正文。' },
  tokenBudget: { type: 'integer', minimum: 256, maximum: 16000, description: 'recall 必填，本次完整返回的本地估算 token 上限，包含引用和省略提示。' },
  asOf: { ...time, description: '查询事实在哪个时间有效，省略为现在。' },
  knownAt: { ...time, description: '仅使用截至这个时间已经记录的信息，省略为现在。' },
};

function optionalIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('ids 必须包含最多 32 个笔记 ID。');
  return [...new Set(value as string[])];
}

export function runNoteGraphTool(args: Record<string, unknown>, messages: PlatformMessage[], toolCallId: string | undefined, visibleMessages: PlatformMessage[]) {
  if (args.action === 'record') return { success: true, noteEvent: createNoteReceipt(messages, toolCallId, parseNoteEntries(args.entries)) };
  const now = Date.now(), asOf = noteQueryTime(args.asOf, now), knownAt = noteQueryTime(args.knownAt, now);
  const graph = buildNoteGraph(messages, asOf, knownAt);
  if (args.action === 'inspect') {
    if (typeof args.noteId !== 'string') throw new Error('inspect 需要 noteId。');
    const note = graph.notes.get(args.noteId);
    if (!note) throw new Error('当前分支没有这条笔记。');
    if (note.recordedAt > knownAt) return { success: true, id: note.id, state: 'outside_time', text: '截至指定记录时间尚无此条笔记。' };
    const state = graph.states.get(note.id);
    if (state === 'source_unavailable') return { success: true, id: note.id, state, text: '来源已删除或改变，请根据有效历史重新记录。' };
    const details = noteDetails(note, state);
    return { success: true, ...details, ...textPage(note.text, args.offset, args.limit), replacements: graph.replacements.get(note.id) ?? [] };
  }
  if (args.action !== 'recall') throw new Error('笔记操作无效。');
  if (!Number.isSafeInteger(args.tokenBudget) || Number(args.tokenBudget) < 256 || Number(args.tokenBudget) > 16000) throw new Error('recall 需要 256 到 16000 之间的 tokenBudget。');
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20000)) throw new Error('limit 必须是 1 到 20000 之间的整数。');
  const options: NoteRecallOptions = { tokenBudget: Number(args.tokenBudget), ids: optionalIds(args.ids),
    ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
    ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    ...(args.asOf == null ? {} : { asOf }), ...(args.knownAt == null ? {} : { knownAt }) };
  return recallContextNotes(graph, messages, options, visibleMessages);
}
