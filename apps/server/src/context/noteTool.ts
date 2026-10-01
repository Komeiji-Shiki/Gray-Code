import type { PlatformMessage } from '@graycode/contracts';
import { buildNoteGraph, createNoteReceipt, NOTE_KINDS, NOTE_RELATIONS, noteDetails, noteQueryTime, parseNoteEntries } from './noteGraph';
import { recallContextNotes, type NoteRecallOptions } from './noteRecall';
import { textPage } from './textPage';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 200 };
const time = { type: 'integer', description: 'UTC Unix 毫秒；没有明确时间依据时省略。' };
export const NOTE_GRAPH_PROPERTIES = {
  entries: { type: 'array', minItems: 1, maxItems: 32, description: 'record 的批量条目，key 在本批内唯一。关系的 target 可以是已返回的笔记 ID，也可以用 @key 指向本批其他条目。',
    items: object({ key: { type: 'string', minLength: 1, maxLength: 80 }, kind: { type: 'string', enum: NOTE_KINDS },
      text: { type: 'string', minLength: 1, maxLength: 4000, description: '笔记正文，保留条件、否定、决定理由和仍未解决的问题。' },
      about: { type: 'array', maxItems: 16, items: id, description: '相关任务、文件、符号或主题。' },
      sources: { type: 'array', minItems: 1, maxItems: 8, items: object({ messageId: { ...id, description: '真实历史 ID，或 last_user / last_assistant / last_tool_result（最近一条工具结果），或 tool:<工具调用 ID>。' },
        quote: { type: 'string', minLength: 1, maxLength: 4000, description: '可选，原文中唯一的一段摘录；返回的偏移可以传给 context_history 的 read。' } }, ['messageId']) },
      relations: { type: 'array', maxItems: 32, items: object({ kind: { type: 'string', enum: NOTE_RELATIONS,
        description: '本条与目标的关系：requires 依赖目标，supports 支持目标，applies_to 适用于目标，contradicts 与目标冲突，supersedes 取代目标。' }, target: id }, ['kind', 'target']) },
      validFrom: time, validTo: time, eventAt: time }, ['key', 'kind', 'text', 'sources']) },
  query: { type: 'string', minLength: 1, maxLength: 1000, description: 'recall 的当前意图；与 ids、taskId 都省略时浏览近期有效的笔记。' },
  ids: { type: 'array', maxItems: 32, items: id, description: 'recall 的起点笔记 ID；已被取代的旧决定会自动找到当前版本。' },
  taskId: { ...id, description: 'recall 以这条任务笔记为起点，补齐它的依赖、约束和依据。' },
  noteId: { ...id, description: 'inspect 要读取的笔记 ID；即使已经召回过也会返回正文。' },
  tokenBudget: { type: 'integer', minimum: 256, maximum: 16000, description: 'recall 必填，本次返回内容的 token 上限（本地估算），引用和省略提示也计入其中。' },
  asOf: { ...time, description: '查询哪个时间点有效的事实，省略时为现在。' },
  knownAt: { ...time, description: '只使用截至该时间已记录的信息，省略时为现在。' },
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
