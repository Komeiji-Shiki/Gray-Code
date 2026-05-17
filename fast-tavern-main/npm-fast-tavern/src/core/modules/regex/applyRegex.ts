import type { RegexScriptData, RegexTarget, RegexView } from '../../types';
import type { VariableContext } from '../variables';
import { replaceMacros } from '../macro';

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceMacroTokens(
  pattern: string,
  macros: Record<string, string>,
  mode: RegexScriptData['macroMode']
): string {
  if (mode === 'none') {
    // none: 不执行 findRegex 中的宏；按宏字面量参与匹配。
    // 例如 {{user}} 会被转成 \{\{user\}\}，避免 "{" 被当成量词语法。
    return pattern
      .replace(
        /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g,
        (m) => escapeRegExpLiteral(m)
      )
      .replace(/<<\s*[a-zA-Z0-9_]+\s*>>/g, (m) => escapeRegExpLiteral(m));
  }

  const pick = (key: string): string | null => {
    if (Object.prototype.hasOwnProperty.call(macros, key)) return String(macros[key]);
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(macros, lower)) return String(macros[lower]);
    return null;
  };

  const encode = (v: string) => (mode === 'escaped' ? escapeRegExpLiteral(v) : v);

  // 仅替换 {{key}} / <<key>> 这类“基础宏”，避免误伤 {{getvar::...}} 等
  const replacer = (_m: string, key: string) => {
    const val = pick(key);
    return val === null ? _m : encode(val);
  };

  return pattern
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, replacer)
    .replace(/<<\s*([a-zA-Z0-9_]+)\s*>>/g, replacer);
}

function parseFindRegex(input: string): { source: string; flags: string } {
  const s = String(input ?? '');
  if (s.startsWith('/')) {
    // 尝试解析 /pattern/flags（尽量贴近 ST 文档）
    // 从后往前找最后一个未转义的 '/'
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i] !== '/') continue;
      // 统计连续反斜杠数量来判断是否转义
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 1) continue; // 被转义的 '/'

      const source = s.slice(1, i);
      const flags = s.slice(i + 1);
      if (/^[gimsuy]*$/.test(flags)) {
        return { source, flags };
      }
      break;
    }
  }
  return { source: s, flags: '' };
}

function applyTrim(match: string, trims: string[]): string {
  let out = match;
  for (const t of trims || []) {
    const needle = String(t ?? '');
    if (!needle) continue;
    out = out.split(needle).join('');
  }
  return out;
}

function interpolateReplacement(template: string, matchTrimmed: string, groups: string[]): string {
  const raw = String(template ?? '');

  // 1) {{match}}
  let out = raw.replace(/\{\{\s*match\s*\}\}/gi, matchTrimmed);

  // 2) 兼容 $& / $1..$99 / $$
  const DOLLAR = '\u0000DOLLAR\u0000';
  out = out.replace(/\$\$/g, DOLLAR);
  out = out.replace(/\$&/g, matchTrimmed);
  out = out.replace(/\$(\d{1,2})/g, (_m, nStr: string) => {
    const n = Number(nStr);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(groups[n - 1] ?? '');
  });
  out = out.replace(new RegExp(DOLLAR, 'g'), '$');

  return out;
}

function shouldApplyByDepth(script: RegexScriptData, target: RegexTarget, historyDepth?: number): boolean {
  if (target !== 'userInput' && target !== 'aiOutput') return true;
  if (historyDepth === undefined) return false; // 非聊天历史项：不吃 depth 规则

  const min = script.minDepth === null || script.minDepth === -1 ? null : script.minDepth;
  const max = script.maxDepth === null || script.maxDepth === -1 ? null : script.maxDepth;

  if (min !== null && historyDepth < min) return false;
  if (max !== null && historyDepth > max) return false;
  return true;
}

/**
 * 按 `st-api-wrapper` 的 RegexScriptData 语义处理文本。
 * - targets/view 过滤
 * - Trim Out + {{match}}
 * - Find Regex 的宏替换（macroMode）
 * - Replace Regex 的宏会在每次替换结果上立刻执行
 * - minDepth/maxDepth（仅对聊天历史 userInput/aiOutput）
 */
export function applyRegex(
  text: string,
  params: {
    scripts: RegexScriptData[];
    target: RegexTarget;
    view: RegexView;
    /** 用于 Find Regex 的宏替换（macroMode=raw/escaped） */
    macros?: Record<string, string>;
    /** 用于 Replace Regex 的变量宏（setvar/getvar 等） */
    variableContext?: VariableContext;
    /** 若该文本来自聊天历史，则提供 depth（0=最后一条） */
    historyDepth?: number;
  }
): string {
  let result = text ?? '';
  const macros = params.macros || {};

  for (const script of params.scripts || []) {
    if (!script?.enabled) continue;
    if (!Array.isArray(script.targets) || script.targets.length === 0) continue;
    if (!Array.isArray(script.view) || script.view.length === 0) continue;
    if (!script.targets.includes(params.target)) continue;
    if (!script.view.includes(params.view)) continue;
    if (!shouldApplyByDepth(script, params.target, params.historyDepth)) continue;

    const substituted = replaceMacroTokens(String(script.findRegex ?? ''), macros, script.macroMode);
    const { source, flags } = parseFindRegex(substituted);

    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch {
      continue;
    }

    const replaceTemplate = String(script.replaceRegex ?? '');
    const trims = Array.isArray(script.trimRegex) ? script.trimRegex : [];

    result = result.replace(re, (...args: any[]) => {
      // args: match, g1, g2, ..., offset, string, groups?
      let namedGroups: any = undefined;
      if (args.length >= 3 && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
        namedGroups = args[args.length - 1];
      }

      const match = String(args[0] ?? '');
      const groupsEnd = namedGroups ? args.length - 3 : args.length - 2;
      const groups = args.slice(1, Math.max(1, groupsEnd)).map((g: any) => String(g ?? ''));

      const matchTrimmed = applyTrim(match, trims);
      const interpolated = interpolateReplacement(replaceTemplate, matchTrimmed, groups);

      // replaceRegex 的结果中若包含宏，需立即执行
      return replaceMacros(interpolated, {
        macros,
        variableContext: params.variableContext,
      });
    });
  }

  return result;
}
