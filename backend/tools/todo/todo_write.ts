/**
 * TODO LIST tool
 *
 * Maintains a per-conversation TODO list that the model can update.
 *
 * Storage: ConversationMetadata.custom['todoList'] (via ToolContext.conversationStore)
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { isTodoStatus, validateTodos } from '../shared/todoValidation';
import type { TodoItem, TodoStatus } from '../shared/todoValidation';

// 保持对外类型导出（todo/index.ts 通过 export * 转发）
export type { TodoItem, TodoStatus } from '../shared/todoValidation';

export interface TodoWriteArgs {
    todos: TodoItem[];
    merge: boolean;
}

const TODO_METADATA_KEY = 'todoList';

async function loadExistingTodos(context: ToolContext): Promise<TodoItem[]> {
    const store = context.conversationStore;
    const conversationId = context.conversationId;

    if (!store || !conversationId) {
        return [];
    }

    const raw = await store.getCustomMetadata(conversationId, TODO_METADATA_KEY);
    if (!Array.isArray(raw)) {
        return [];
    }

    // Best-effort normalize
    const normalized: TodoItem[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as Record<string, unknown>).id;
        const content = (item as Record<string, unknown>).content;
        const status = (item as Record<string, unknown>).status;
        if (typeof id === 'string' && typeof content === 'string' && isTodoStatus(status)) {
            normalized.push({ id, content, status });
        }
    }
    return normalized;
}

async function saveTodos(context: ToolContext, todos: TodoItem[]): Promise<void> {
    const store = context.conversationStore;
    const conversationId = context.conversationId;

    if (!store || !conversationId) {
        throw new Error('conversationStore and conversationId are required');
    }

    await store.setCustomMetadata(conversationId, TODO_METADATA_KEY, todos);
}

function countByStatus(todos: TodoItem[]): Record<TodoStatus, number> {
    const c: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const t of todos) c[t.status]++;
    return c;
}

export function createTodoWriteToolDeclaration(): ToolDeclaration {
    return {
        name: 'todo_write',
        strict: true,  // API 端强制 schema 校验
        description: 'Create/replace the per-conversation TODO list (ConversationMetadata.custom["todoList"]). IMPORTANT: Use this tool to initialize the list. For incremental updates (status/content), use todo_update.',
        category: 'todo',
        parameters: {
            type: 'object',
            properties: {
                todos: {
                    type: 'array',
                    description: 'Array of todo items',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Unique todo id' },
                            content: { type: 'string', description: 'Todo content' },
                            status: {
                                type: 'string',
                                description: 'Todo status',
                                enum: ['pending', 'in_progress', 'completed', 'cancelled']
                            }
                        },
                        required: ['id', 'content', 'status']
                    }
                },
            },
            required: ['todos']
        }
    };
}

async function todoWriteHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    if (!context) {
        return { success: false, error: 'tool context is required' };
    }

    const conversationId = context.conversationId;
    const conversationStore = context.conversationStore;
    if (!conversationId) {
        return { success: false, error: 'conversationId is required in tool context' };
    }
    if (!conversationStore) {
        return { success: false, error: 'conversationStore is required in tool context' };
    }

    const validated = validateTodos(args.todos);
    if (validated.ok === false) {
        return { success: false, error: validated.error };
    }

    try {
        // Always replace the entire list.
        // Note: We intentionally ignore any extra args (e.g. legacy "merge") for compatibility.
        await saveTodos(context, validated.todos);
        return {
            success: true,
            data: {
                total: validated.todos.length,
                counts: countByStatus(validated.todos)
            }
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createTodoWriteTool(): Tool {
    return {
        declaration: createTodoWriteToolDeclaration(),
        handler: todoWriteHandler
    };
}

export function registerTodoWrite(): Tool {
    return createTodoWriteTool();
}
