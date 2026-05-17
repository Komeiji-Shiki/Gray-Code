import { VariableScope } from '../../types';

/**
 * 变量上下文
 * 用于在宏替换过程中存储和读取变量
 */
export interface VariableContext {
  /** 局部变量（每次构建独立） */
  local: Record<string, any>;
  /** 全局变量（跨构建持久化，由外部管理） */
  global: Record<string, any>;
}

// Removed duplicate VariableScope definition

/**
 * 创建变量上下文
 */
export function createVariableContext(
  initialLocal?: Record<string, any>,
  initialGlobal?: Record<string, any>
): VariableContext {
  return {
    local: { ...initialLocal },
    global: { ...initialGlobal }
  };
}

function pickStore(ctx: VariableContext, scope: VariableScope | undefined) {
  return (scope ?? 'local') === 'global' ? ctx.global : ctx.local;
}

/**
 * 获取局部变量
 */
export function getVar(ctx: VariableContext, name: string): any {
  return ctx.local[name] ?? '';
}

/**
 * 设置局部变量
 */
export function setVar(ctx: VariableContext, name: string, value: any): void {
  ctx.local[name] = value;
}

/**
 * 获取全局变量
 */
export function getGlobalVar(ctx: VariableContext, name: string): any {
  return ctx.global[name] ?? '';
}

/**
 * 设置全局变量
 */
export function setGlobalVar(ctx: VariableContext, name: string, value: any): void {
  ctx.global[name] = value;
}

/**
 * 对齐 st-api-wrapper：变量操作（纯函数式，直接改 ctx；返回 ok/value/variables 的包装结构）
 */
export function variablesGet(ctx: VariableContext, input: { name: string; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  return { value: store[String(input?.name ?? '')] };
}

export function variablesList(ctx: VariableContext, input?: { scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  return { variables: { ...store } };
}

export function variablesSet(ctx: VariableContext, input: { name: string; value: any; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  store[String(input?.name ?? '')] = input?.value;
  return { ok: true };
}

export function variablesDelete(ctx: VariableContext, input: { name: string; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  delete store[String(input?.name ?? '')];
  return { ok: true };
}

export function variablesAdd(ctx: VariableContext, input: { name: string; value: any; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  const name = String(input?.name ?? '');
  const cur = store[name];
  const nextVal = (() => {
    if (cur === undefined) return input?.value;
    const curNum = typeof cur === 'number' ? cur : Number(cur);
    const addNum = typeof input?.value === 'number' ? input.value : Number(input?.value);
    if (Number.isFinite(curNum) && Number.isFinite(addNum)) return curNum + addNum;
    return String(cur ?? '') + String(input?.value ?? '');
  })();
  store[name] = nextVal;
  return { ok: true };
}

export function variablesInc(ctx: VariableContext, input: { name: string; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  const name = String(input?.name ?? '');
  const cur = store[name];
  const curNum = typeof cur === 'number' ? cur : Number(cur);
  store[name] = (Number.isFinite(curNum) ? curNum : 0) + 1;
  return { ok: true };
}

export function variablesDec(ctx: VariableContext, input: { name: string; scope?: VariableScope }) {
  const store = pickStore(ctx, input?.scope);
  const name = String(input?.name ?? '');
  const cur = store[name];
  const curNum = typeof cur === 'number' ? cur : Number(cur);
  store[name] = (Number.isFinite(curNum) ? curNum : 0) - 1;
  return { ok: true };
}

export const Variables = {
  get: variablesGet,
  list: variablesList,
  set: variablesSet,
  delete: variablesDelete,
  add: variablesAdd,
  inc: variablesInc,
  dec: variablesDec,
} as const;

function stringifyVariableValue(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 处理文本中的变量宏
 * 支持的宏（同时支持 {{}} 和 <<>> 格式）：
 * - {{getvar::name}} / <<getvar::name>> - 获取局部变量
 * - {{setvar::name::value}} / <<setvar::name::value>> - 设置局部变量（替换为空字符串）
 * - {{getglobalvar::name}} / <<getglobalvar::name>> - 获取全局变量
 * - {{setglobalvar::name::value}} / <<setglobalvar::name::value>> - 设置全局变量（替换为空字符串）
 */
export function processVariableMacros(text: string, ctx: VariableContext): string {
  if (!text) return '';

  let result = text;

  // ========== 处理 {{}} 格式 ==========
  
  // 处理 {{setvar::name::value}} - 必须先处理 set，因为 set 可能影响后续 get
  result = result.replace(
    /\{\{\s*setvar\s*::\s*([^:}]+)\s*::\s*([^}]*)\s*\}\}/gi,
    (_match, name: string, value: string) => {
      setVar(ctx, name.trim(), value.trim());
      return ''; // 替换为空字符串
    }
  );

  // 处理 {{setglobalvar::name::value}}
  result = result.replace(
    /\{\{\s*setglobalvar\s*::\s*([^:}]+)\s*::\s*([^}]*)\s*\}\}/gi,
    (_match, name: string, value: string) => {
      setGlobalVar(ctx, name.trim(), value.trim());
      return ''; // 替换为空字符串
    }
  );

  // 处理 {{getvar::name}}
  result = result.replace(
    /\{\{\s*getvar\s*::\s*([^}]+)\s*\}\}/gi,
    (_match, name: string) => {
      return stringifyVariableValue(getVar(ctx, name.trim()));
    }
  );

  // 处理 {{getglobalvar::name}}
  result = result.replace(
    /\{\{\s*getglobalvar\s*::\s*([^}]+)\s*\}\}/gi,
    (_match, name: string) => {
      return stringifyVariableValue(getGlobalVar(ctx, name.trim()));
    }
  );

  // ========== 处理 <<>> 格式 ==========
  
  // 处理 <<setvar::name::value>>
  result = result.replace(
    /<<\s*setvar\s*::\s*([^:>]+)\s*::\s*([^>]*)\s*>>/gi,
    (_match, name: string, value: string) => {
      setVar(ctx, name.trim(), value.trim());
      return ''; // 替换为空字符串
    }
  );

  // 处理 <<setglobalvar::name::value>>
  result = result.replace(
    /<<\s*setglobalvar\s*::\s*([^:>]+)\s*::\s*([^>]*)\s*>>/gi,
    (_match, name: string, value: string) => {
      setGlobalVar(ctx, name.trim(), value.trim());
      return ''; // 替换为空字符串
    }
  );

  // 处理 <<getvar::name>>
  result = result.replace(
    /<<\s*getvar\s*::\s*([^>]+)\s*>>/gi,
    (_match, name: string) => {
      return stringifyVariableValue(getVar(ctx, name.trim()));
    }
  );

  // 处理 <<getglobalvar::name>>
  result = result.replace(
    /<<\s*getglobalvar\s*::\s*([^>]+)\s*>>/gi,
    (_match, name: string) => {
      return stringifyVariableValue(getGlobalVar(ctx, name.trim()));
    }
  );

  return result;
}

/**
 * 获取变量上下文的变化（用于返回给调用方）
 */
export function getVariableChanges(
  original: VariableContext,
  current: VariableContext
): {
  localChanges: Record<string, any>;
  globalChanges: Record<string, any>;
} {
  const localChanges: Record<string, any> = {};
  const globalChanges: Record<string, any> = {};

  // 检测局部变量变化
  for (const [key, value] of Object.entries(current.local)) {
    if (original.local[key] !== value) {
      localChanges[key] = value;
    }
  }

  // 检测全局变量变化
  for (const [key, value] of Object.entries(current.global)) {
    if (original.global[key] !== value) {
      globalChanges[key] = value;
    }
  }

  return { localChanges, globalChanges };
}
