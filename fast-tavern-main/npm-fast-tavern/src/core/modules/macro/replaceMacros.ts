import type { VariableContext } from '../variables';
import { processVariableMacros } from '../variables';

/**
 * 宏替换选项
 */
export interface ReplaceMacrosOptions {
  /** 基础宏变量，如 { char: 'Alice', user: 'Bob' } */
  macros?: Record<string, string>;
  /** 变量上下文（用于处理 getvar/setvar 等宏） */
  variableContext?: VariableContext;
}

/**
 * 宏替换。
 * 支持的语法：
 * - {{char}} {{user}} 以及任意 {{key}}
 * - <<char>> <<user>> 以及任意 <<key>>
 * - {{getvar::name}} - 获取局部变量
 * - {{setvar::name::value}} - 设置局部变量
 * - {{getglobalvar::name}} - 获取全局变量
 * - {{setglobalvar::name::value}} - 设置全局变量
 */
export function replaceMacros(text: string, options: ReplaceMacrosOptions | Record<string, string>): string {
  if (!text) return '';

  // 兼容旧的 API（直接传 macros 对象）
  const opts: ReplaceMacrosOptions = 
    options && ('macros' in options || 'variableContext' in options)
      ? options as ReplaceMacrosOptions
      : { macros: options as Record<string, string> };

  const macros = opts.macros || {};
  let out = text;

  // 1. 先处理变量宏（如果有变量上下文）
  if (opts.variableContext) {
    out = processVariableMacros(out, opts.variableContext);
  }

  // 2. 处理 <<key>> 格式（包括 <<user>> 和 <<char>>）
  out = out.replace(/<<\s*([a-zA-Z0-9_]+)\s*>>/g, (_m, key: string) => {
    const lowerKey = key.toLowerCase();
    // 先尝试精确匹配，再尝试小写匹配
    if (Object.prototype.hasOwnProperty.call(macros, key)) {
      return String(macros[key]);
    }
    if (Object.prototype.hasOwnProperty.call(macros, lowerKey)) {
      return String(macros[lowerKey]);
    }
    return _m; // 未知宏保持原样
  });

  // 3. 处理 {{key}} 格式（排除已处理的变量宏）
  out = out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const lowerKey = key.toLowerCase();
    // 跳过变量宏关键字（已在上面处理）
    if (['getvar', 'setvar', 'getglobalvar', 'setglobalvar'].includes(lowerKey)) {
      return _m;
    }
    // 先尝试精确匹配，再尝试小写匹配
    if (Object.prototype.hasOwnProperty.call(macros, key)) {
      return String(macros[key]);
    }
    if (Object.prototype.hasOwnProperty.call(macros, lowerKey)) {
      return String(macros[lowerKey]);
    }
    return _m; // 未知宏保持原样
  });

  return out;
}
