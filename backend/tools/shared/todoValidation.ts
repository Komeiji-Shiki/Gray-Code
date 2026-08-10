/**
 * TODO 结构校验（从 todo/todo_write、progress/documentLayout、plan/todoListSection 收敛而来）
 *
 * 三家的差异通过参数化保留：
 * - todo_write：严格校验 + 返回原始条目（content 仅要求 string，不检查重复 id）
 * - progress：严格校验 + 内容需归一化后非空 + 检查重复 id
 * - plan：宽松归一化（跳过非法条目、status 默认 pending），保留在 plan/todoListSection 本地
 */

import { normalizeSingleLineText } from './textUtils';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'cancelled';
}

export interface ValidateTodosOptions {
  /** 内容是否要求「归一化后非空」（progress 语义；默认 false：仅要求 string，todo_write 语义） */
  requireNonEmptyContent?: boolean;
  /** 是否检查重复 id（progress 语义；默认 false） */
  checkDuplicates?: boolean;
  /** 重复 id 错误文案中的字段前缀（默认 'todo'） */
  duplicateFieldName?: string;
}

/**
 * 校验 TODO 数组。
 *
 * 错误文案与各调用方原实现逐字一致；返回的条目为原始值（不做归一化），
 * 以保持 todo_write「原样存储」的既有行为。
 */
export function validateTodos(
  value: unknown,
  options: ValidateTodosOptions = {}
): { ok: true; todos: TodoItem[] } | { ok: false; error: string } {
  const requireNonEmptyContent = options.requireNonEmptyContent ?? false;
  const checkDuplicates = options.checkDuplicates ?? false;
  const duplicateFieldName = options.duplicateFieldName ?? 'todo';

  if (!Array.isArray(value)) {
    return { ok: false, error: 'todos must be an array' };
  }

  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'each todo must be an object' };
    }
    const id = (item as Record<string, unknown>).id;
    const content = (item as Record<string, unknown>).content;
    const status = (item as Record<string, unknown>).status;

    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: 'todo.id must be a non-empty string' };
    }
    if (requireNonEmptyContent) {
      if (!normalizeSingleLineText(content)) {
        return { ok: false, error: 'todo.content must be a non-empty string' };
      }
    } else if (typeof content !== 'string') {
      return { ok: false, error: 'todo.content must be a string' };
    }
    if (!isTodoStatus(status)) {
      return { ok: false, error: 'todo.status must be one of: pending, in_progress, completed, cancelled' };
    }

    todos.push({ id, content: content as string, status });
  }

  if (checkDuplicates) {
    const duplicates = findDuplicateIds(value, duplicateFieldName);
    if (duplicates.length > 0) {
      return { ok: false, error: `duplicate todo ids are not allowed: ${duplicates.join(', ')}` };
    }
  }

  return { ok: true, todos };
}

/**
 * 收集重复 id（归一化后比较，空 id 跳过），返回 `${fieldName}:${id}` 列表（按首次出现顺序）。
 */
export function findDuplicateIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rawId = (item as Record<string, unknown>).id;
    const id = normalizeSingleLineText(rawId);
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }

  return Array.from(duplicates).map((id) => `${fieldName}:${id}`);
}
