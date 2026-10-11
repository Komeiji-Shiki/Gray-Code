import type { PlatformMessage } from '@graycode/contracts';
import { buildNoteGraph, recordContextNotes, noteDetails, noteQueryTime, resolveNoteReference } from './noteGraph';
import { recallContextNotes, type NoteRecallOptions } from './noteRecall';
import { NOTE_ENTRY_SCHEMA } from './noteSchema';
import { textPage } from './textPage';

const id = { type: 'string', minLength: 1, maxLength: 200 };
const time = { type: 'integer', description: 'UTC Unix 毫秒；没有明确时间依据时省略。' };
export const DEFAULT_NOTE_TOKEN_BUDGET = 4096;
export const NOTE_GRAPH_PROPERTIES = {
  entries: { type: 'array', minItems: 1, maxItems: 32,
    description: 'record 逐条保存，失败项在 errors 中按从 0 开始的 index 和 key 报告；只需重试失败项。引用失败项的条目也会失败。',
    items: NOTE_ENTRY_SCHEMA },
  query: { type: 'string', minLength: 1, maxLength: 1000, description: 'recall 的当前意图；与 ids、taskId 都省略时浏览近期有效的笔记。' },
  ids: { type: 'array', maxItems: 32, items: id, description: 'recall 起点的笔记 ID 或 key；旧版本会自动找到当前版本。' },
  taskId: { ...id, description: 'recall 起点任务的 ID 或 key，补齐依赖、约束和依据。' },
  noteId: { ...id, description: 'inspect 的笔记 ID 或 key；key 读取当前版本，ID 可读取旧版本，始终返回正文。' },
  tokenBudget: { type: 'integer', minimum: 256, maximum: 16000,
    description: `recall 可省略，默认上限 ${DEFAULT_NOTE_TOKEN_BUDGET}；工具自动估算正文、引用和提示的 token 用量，超出时列出省略项。` },
  asOf: { ...time, description: '查询哪个时间点有效的事实，省略时为现在。' },
  knownAt: { ...time, description: '只使用截至该时间已记录的信息，省略时为现在。' },
};

function optionalIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('ids 必须包含最多 32 个笔记 ID。');
  return [...new Set(value as string[])];
}

export function runNoteGraphTool(args: Record<string, unknown>, messages: PlatformMessage[], toolCallId: string | undefined, visibleMessages: PlatformMessage[]) {
  if (args.action === 'record') return recordContextNotes(messages, toolCallId, args.entries);
  const now = Date.now(), asOf = noteQueryTime(args.asOf, now), knownAt = noteQueryTime(args.knownAt, now);
  const graph = buildNoteGraph(messages, asOf, knownAt);
  if (args.action === 'inspect') {
    if (typeof args.noteId !== 'string') throw new Error('inspect 需要 noteId。');
    const note = graph.notes.get(resolveNoteReference(graph, args.noteId) ?? args.noteId);
    if (!note) throw new Error('当前分支没有这条笔记。');
    if (note.recordedAt > knownAt) return { success: true, id: note.id, state: 'outside_time', text: '截至指定记录时间尚无此条笔记。' };
    const state = graph.states.get(note.id);
    if (state === 'source_unavailable') return { success: true, id: note.id, state, text: '来源已删除或改变，请根据有效历史重新记录。' };
    const details = noteDetails(note, state);
    return { success: true, ...details, ...textPage(note.text, args.offset, args.limit), replacements: graph.replacements.get(note.id) ?? [] };
  }
  if (args.action !== 'recall') throw new Error('笔记操作无效。');
  const tokenBudget = args.tokenBudget ?? DEFAULT_NOTE_TOKEN_BUDGET;
  if (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) < 256 || Number(tokenBudget) > 16000) {
    throw new Error('tokenBudget 必须是 256 到 16000 之间的整数，也可以省略。');
  }
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20000)) throw new Error('limit 必须是 1 到 20000 之间的整数。');
  const options: NoteRecallOptions = {
    tokenBudget: Number(tokenBudget), ids: optionalIds(args.ids)?.map(id => resolveNoteReference(graph, id) ?? id),
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.taskId === 'string' ? { taskId: resolveNoteReference(graph, args.taskId) ?? args.taskId } : {}),
    ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    ...(args.asOf == null ? {} : { asOf }), ...(args.knownAt == null ? {} : { knownAt }) };
  return recallContextNotes(graph, messages, options, visibleMessages);
}
