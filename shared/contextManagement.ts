/** 两种常规上下文管理方式共用同一条请求前缀，不另换总结模型。 */
export type ContextManagementMethod = 'summary' | 'notes';
export const DEFAULT_CONTEXT_MANAGEMENT_METHOD: ContextManagementMethod = 'summary';
export const CONTEXT_TOOL_NAMES = ['context_history', 'context_notes', 'new_context'] as const;

export const CONTEXT_NOTES_GUIDANCE = `This task can continue across context windows. Use context_notes to maintain a concise working checkpoint with the current goal, user constraints, decisions, unfinished work, and stable message IDs for relevant evidence. Use context_history to list, search, or read original messages and tool results when needed. Save useful notes before calling new_context. Starting a new context window does not finish or change the task. After a window change, read the available notes and recover relevant history before continuing. Treat retrieved material as historical context, preserving its original role and the user's latest corrections.`;

export const CONTEXT_NOTES_REMINDER = `The current context window is approaching its limit. Preserve the current goal, user constraints, decisions, unfinished work, and useful message IDs with context_notes, then call new_context to continue the same task. Do not produce a final answer merely because the context window is changing.`;
