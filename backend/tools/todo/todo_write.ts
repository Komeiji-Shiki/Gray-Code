/**
 * TODO LIST tool
 *
 * Maintains a per-conversation TODO list that the model can update.
 *
 * Storage: ConversationMetadata.custom['todoList'] (via ToolContext.conversationStore)
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { validateTodos } from '../shared/todoValidation';
import type { TodoItem, TodoStatus } from '../shared/todoValidation';
import { TODO_ITEM_SCHEMA, TODO_STATUS_SCHEMA } from '../shared/todoSchema';

// 保持对外类型导出（todo/index.ts 通过 export * 转发）
export type { TodoItem, TodoStatus } from '../shared/todoValidation';

export interface TodoWriteArgs {
    todos: TodoItem[];
    merge: boolean;
}

const TODO_METADATA_KEY = 'todoList';

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
        description: '创建或整体替换当前会话的待办清单，传入的 todos 会替换旧清单。'
          + '修改单项状态或内容请用 todo_update。'
          + '结果返回各状态数量，不重复返回整张清单。',
        category: 'todo',
        parameters: {
            type: 'object',
            properties: {
                todos: {
                    type: 'array',
                    description: '完整的待办事项数组。',
                    items: {
                        type: TODO_ITEM_SCHEMA.type,
                        properties: {
                            id: { ...TODO_ITEM_SCHEMA.properties.id, description: '事项的唯一 ID。' },
                            content: { ...TODO_ITEM_SCHEMA.properties.content, description: '事项内容。' },
                            status: {
                                type: TODO_STATUS_SCHEMA.type,
                                description: '事项状态。',
                                enum: [...TODO_STATUS_SCHEMA.enum]
                            }
                        },
                        required: [...TODO_ITEM_SCHEMA.required]
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
