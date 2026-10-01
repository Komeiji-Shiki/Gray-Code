/** 两种常规上下文管理方式共用同一条请求前缀，不另换总结模型。 */
export type ContextManagementMethod = 'summary' | 'notes';
export const DEFAULT_CONTEXT_MANAGEMENT_METHOD: ContextManagementMethod = 'summary';
export type ContextUserMessageRetention = 'first' | 'all';
export const DEFAULT_USER_MESSAGE_RETENTION: ContextUserMessageRetention = 'first';
export const CONTEXT_TOOL_NAMES = ['context_history', 'context_notes', 'new_context'] as const;

export const CONTEXT_NOTES_GUIDANCE = `This task can continue across context windows, so keep working notes with context_notes.

Recording: as constraints, decisions, observations, hypotheses, lessons or next steps become clear, save them in batches with action=record. Cite the real history messages they come from, and keep the conditions and reasons. Link related notes with requires, supports or applies_to, and use supersedes when a note explicitly replaces another. Leave unresolved contradictions visible, and do not turn your own inference into a user requirement. Notes and retrieved results are fixed snapshots: record a correction as a new note instead of rewriting earlier ones.

Recalling: before a step that depends on earlier evidence, and after switching context, use action=recall with the current intent or a taskId and an explicit tokenBudget. Recall follows the linked evidence and skips text already visible in the context. Check omitted, unavailable and missingDependencies before treating the evidence as complete. inspect rereads a note by noteId, and context_history reads the exact source messages.

Switching: save useful notes before calling new_context. The new context continues the same unfinished task. Free-form notes with write, append, list and read are also available.`;

export const CONTEXT_NOTES_REMINDER = `The context window is nearly full. Save the useful constraints, decisions, evidence and unfinished steps with context_notes, either as a batch record or as a working checkpoint, then call new_context to continue the same task. In the new window, recall the task and its dependencies with a bounded tokenBudget. A context switch is not a reason to give a final answer.`;
