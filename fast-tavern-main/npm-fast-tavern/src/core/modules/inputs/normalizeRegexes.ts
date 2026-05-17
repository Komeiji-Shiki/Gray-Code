import type { RegexScriptData, RegexScriptsInput, RegexScriptsFileInput } from '../../types';

function isRegexScriptArray(v: unknown): v is RegexScriptData[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === 'object' && x !== null && 'findRegex' in (x as any) && 'replaceRegex' in (x as any))
  );
}

function normalizeView(v: any): 'user' | 'model' | null {
  if (v === 'user' || v === 'model') return v;
  if (v === 'user_view') return 'user';
  if (v === 'model_view' || v === 'assistant_view') return 'model';
  return null;
}

function normalizeTarget(v: any): any {
  if (v === 'userInput' || v === 'aiOutput' || v === 'slashCommands' || v === 'worldBook' || v === 'reasoning') return v;
  // 兼容旧字段（尽量不鼓励，但不至于直接炸）
  if (v === 'user') return 'userInput';
  if (v === 'model' || v === 'assistant_response') return 'aiOutput';
  if (v === 'preset') return 'slashCommands';
  if (v === 'world_book') return 'worldBook';
  return null;
}

function toArray<T>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

function normalizeOne(item: any): RegexScriptData | null {
  if (!item || typeof item !== 'object') return null;
  if (!('findRegex' in item)) return null;

  const id = String((item as any).id ?? '');
  if (!id) return null;

  const name = String((item as any).name ?? '');
  const enabled = (item as any).enabled !== false;

  const findRegex = String((item as any).findRegex ?? '');
  const replaceRegex = String((item as any).replaceRegex ?? '');

  const trimRegex = toArray<any>((item as any).trimRegex).map(String);

  const targets = toArray<any>((item as any).targets).map(normalizeTarget).filter(Boolean);
  const view = toArray<any>((item as any).view).map(normalizeView).filter(Boolean) as any[];

  const runOnEdit = !!(item as any).runOnEdit;
  const macroModeRaw = String((item as any).macroMode ?? 'none');
  const macroMode = macroModeRaw === 'raw' || macroModeRaw === 'escaped' || macroModeRaw === 'none' ? macroModeRaw : 'none';

  const minDepth = (item as any).minDepth === null || typeof (item as any).minDepth === 'number' ? (item as any).minDepth : null;
  const maxDepth = (item as any).maxDepth === null || typeof (item as any).maxDepth === 'number' ? (item as any).maxDepth : null;

  return {
    id,
    name,
    enabled,
    findRegex,
    replaceRegex,
    trimRegex,
    targets,
    view,
    runOnEdit,
    macroMode,
    minDepth,
    maxDepth,
  } as RegexScriptData;
}

/**
 * 兼容一次性传入多个“正则脚本文件”（多文件）。
 * 支持：
 * - RegexScriptData[]
 * - { regexScripts: RegexScriptData[] }
 * - { scripts: RegexScriptData[] }
 * - RegexScriptData
 * - 以上任意形式的数组（多文件）
 */
export function normalizeRegexes(input?: RegexScriptsInput): RegexScriptData[] {
  if (!input) return [];

  // 同 normalizeWorldbooks：既可能是“单文件的 RegexScriptData[]”，也可能是“多文件数组”。
  const files: RegexScriptsFileInput[] = [];

  if (Array.isArray(input)) {
    if (isRegexScriptArray(input)) {
      files.push(input);
    } else {
      files.push(...(input as any[]));
    }
  } else {
    files.push(input);
  }

  const out: RegexScriptData[] = [];

  for (const item of files) {
    if (!item) continue;

    // RegexScriptData[]
    if (isRegexScriptArray(item)) {
      for (const s of item) {
        const n = normalizeOne(s);
        if (n) out.push(n);
      }
      continue;
    }

    // { regexScripts: [...] }
    if (typeof item === 'object' && item !== null && Array.isArray((item as any).regexScripts)) {
      for (const s of (item as any).regexScripts) {
        const n = normalizeOne(s);
        if (n) out.push(n);
      }
      continue;
    }

    // { scripts: [...] }
    if (typeof item === 'object' && item !== null && Array.isArray((item as any).scripts)) {
      for (const s of (item as any).scripts) {
        const n = normalizeOne(s);
        if (n) out.push(n);
      }
      continue;
    }

    // RegexScriptData
    const n = normalizeOne(item);
    if (n) out.push(n);
  }

  return out;
}

