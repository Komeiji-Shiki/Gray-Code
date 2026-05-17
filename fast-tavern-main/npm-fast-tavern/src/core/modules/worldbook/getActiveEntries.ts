import type { WorldBook, WorldBookEntry } from '../../types';
import { normalizeWorldbooks } from '../inputs';

function normalizeProbability(p: any): number {
  const n = typeof p === 'number' ? p : Number(p);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, n));
}

function normalizeCaseSensitive(entry: WorldBookEntry, defaultCaseSensitive: boolean): boolean {
  if (typeof entry.caseSensitive === 'boolean') return entry.caseSensitive;
  return defaultCaseSensitive;
}

function includesKeyword(text: string, keyword: string, caseSensitive: boolean): boolean {
  if (!keyword) return false;
  if (caseSensitive) return text.includes(keyword);
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function anyIncluded(text: string, keywords: string[], caseSensitive: boolean): boolean {
  return (keywords || []).some((k) => includesKeyword(text, k, caseSensitive));
}

function allIncluded(text: string, keywords: string[], caseSensitive: boolean): boolean {
  const list = (keywords || []).filter((k) => k);
  if (list.length === 0) return true;
  return list.every((k) => includesKeyword(text, k, caseSensitive));
}

function secondaryLogicPass(
  logic: WorldBookEntry['selectiveLogic'],
  text: string,
  secondary: string[],
  caseSensitive: boolean
): boolean {
  const list = (secondary || []).filter((k) => k);
  if (list.length === 0) return true;

  switch (logic) {
    case 'andAny':
      return anyIncluded(text, list, caseSensitive);
    case 'andAll':
      return allIncluded(text, list, caseSensitive);
    case 'notAny':
      return !anyIncluded(text, list, caseSensitive);
    case 'notAll':
      return !allIncluded(text, list, caseSensitive);
    default:
      return anyIncluded(text, list, caseSensitive);
  }
}

function keywordTriggered(entry: WorldBookEntry, text: string, caseSensitive: boolean): boolean {
  // 约定：key 为空时，用 secondaryKey 当作主关键词（更鲁棒）
  const primary = (entry.key || []).filter((k) => k);
  const primaryList = primary.length > 0 ? primary : (entry.secondaryKey || []).filter((k) => k);
  if (primaryList.length === 0) return false;

  const primaryHit = anyIncluded(text, primaryList, caseSensitive);
  if (!primaryHit) return false;

  // key 非空且 secondaryKey 非空时，按 selectiveLogic 再做一次过滤
  if ((entry.key || []).length > 0) {
    return secondaryLogicPass(entry.selectiveLogic, text, entry.secondaryKey || [], caseSensitive);
  }

  return true;
}

function asSet(v: Set<number> | number[] | undefined): Set<number> {
  if (!v) return new Set();
  if (v instanceof Set) return v;
  return new Set((v || []).filter((x) => typeof x === 'number' && Number.isFinite(x)));
}

/**
 * 计算激活的世界书条目（对齐 st-api-wrapper 的字段语义）。
 * - 支持 keyword/always/vector（vector 需要注入回调）
 * - 支持 probability（0-100）
 * - 支持递归：excludeRecursion / preventRecursion
 */
export function getActiveEntries(params: {
  contextText?: string;
  /** 已归一化后的全局世界书 entries（建议用 normalizeWorldbooks 先处理多文件输入） */
  globalEntries?: WorldBookEntry[];
  /** 角色绑定的世界书（可选） */
  characterWorldBook?: WorldBook | null;
  options?: {
    vectorSearch?: (params: { entries: WorldBookEntry[]; contextText: string }) => Set<number> | number[];
    recursionLimit?: number;
    rng?: () => number;
    defaultCaseSensitive?: boolean;
  };
}): WorldBookEntry[] {
  const {
    contextText = '',
    globalEntries = [],
    characterWorldBook,
    options,
  } = params;

  const defaultCaseSensitive = options?.defaultCaseSensitive ?? false;
  const recursionLimit = Math.max(0, Math.trunc(options?.recursionLimit ?? 5));
  const rng = options?.rng ?? Math.random;

  const all: Array<{ entry: WorldBookEntry; source: 'global' | 'character'; prio: number; seq: number }> = [];

  // 1) global（已归一化为严格 WorldBookEntry）
  (globalEntries || []).forEach((e, idx) => {
    if (!e) return;
    all.push({ entry: e, source: 'global', prio: 1, seq: idx });
  });

  // 2) character（输入 worldBook 需要归一化）
  if (characterWorldBook) {
    const list = normalizeWorldbooks(characterWorldBook);
    list.forEach((e, idx) => {
      if (!e) return;
      all.push({ entry: e, source: 'character', prio: 2, seq: idx });
    });
  }

  // vectorSearch（最多调用一次）
  const vectorHits = (() => {
    if (!options?.vectorSearch) return new Set<number>();
    const res = options.vectorSearch({ entries: all.map((x) => x.entry), contextText });
    return asSet(res);
  })();

  const byIndex = new Map<number, { entry: WorldBookEntry; prio: number; seq: number }>();
  const probFailed = new Set<number>();

  let recursionContext = contextText;

  const consider = (entry: WorldBookEntry, iteration: number) => {
    if (!entry.enabled) return false;

    // excludeRecursion: 不被“递归上下文”触发（只用 base context）
    const ctx = iteration > 0 && entry.excludeRecursion ? contextText : recursionContext;
    const caseSensitive = normalizeCaseSensitive(entry, defaultCaseSensitive);

    if (entry.activationMode === 'always') return true;
    if (entry.activationMode === 'keyword') return keywordTriggered(entry, ctx, caseSensitive);
    if (entry.activationMode === 'vector') return vectorHits.has(entry.index);

    return false;
  };

  const passProbability = (entry: WorldBookEntry) => {
    const p = normalizeProbability(entry.probability);
    if (p >= 100) return true;
    if (p <= 0) return false;
    return rng() * 100 < p;
  };

  for (let iteration = 0; iteration <= recursionLimit; iteration++) {
    let anyNew = false;

    for (const node of all) {
      const entry = node.entry;
      if (!entry) continue;
      if (byIndex.has(entry.index)) continue;
      if (probFailed.has(entry.index)) continue;

      if (!consider(entry, iteration)) continue;

      if (!passProbability(entry)) {
        probFailed.add(entry.index);
        continue;
      }

      byIndex.set(entry.index, { entry, prio: node.prio, seq: node.seq });
      anyNew = true;

      // preventRecursion: 不参与“递归上下文”
      if (!entry.preventRecursion && entry.content) {
        recursionContext = recursionContext ? `${recursionContext}\n${entry.content}` : entry.content;
      }
    }

    if (!anyNew) break;
  }

  const active = Array.from(byIndex.values());

  // 排序：先 order，再 source priority（global -> character），最后 seq 稳定
  active.sort((a, b) => {
    const ao = typeof a.entry.order === 'number' ? a.entry.order : Number(a.entry.order);
    const bo = typeof b.entry.order === 'number' ? b.entry.order : Number(b.entry.order);
    if (ao !== bo) return ao - bo;
    if (a.prio !== b.prio) return a.prio - b.prio;
    return a.seq - b.seq;
  });

  return active.map((x) => x.entry);
}

