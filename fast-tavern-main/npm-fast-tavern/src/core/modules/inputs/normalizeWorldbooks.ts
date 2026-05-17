import type { WorldBookEntry, WorldBooksInput, WorldBookInput } from '../../types';

function isWorldBookEntryArray(v: unknown): v is WorldBookEntry[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && 'content' in (x as any));
}

function toNumber(v: any, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: any, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function normalizeOneEntry(e: any): WorldBookEntry | null {
  if (!e || typeof e !== 'object') return null;

  const position = String((e as any).position ?? '');
  if (!position) return null;

  const index = toNumber((e as any).index, NaN);
  if (!Number.isFinite(index)) return null;

  const name = String((e as any).name ?? '');
  const content = String((e as any).content ?? '');

  const enabled = toBool((e as any).enabled, true);

  const activationModeRaw = String((e as any).activationMode ?? 'keyword');
  const activationMode =
    activationModeRaw === 'always' || activationModeRaw === 'keyword' || activationModeRaw === 'vector'
      ? activationModeRaw
      : 'keyword';

  const key = Array.isArray((e as any).key) ? (e as any).key.map(String) : [];
  const secondaryKey = Array.isArray((e as any).secondaryKey) ? (e as any).secondaryKey.map(String) : [];

  const selectiveLogicRaw = String((e as any).selectiveLogic ?? 'andAny');
  const selectiveLogic =
    selectiveLogicRaw === 'andAny' ||
    selectiveLogicRaw === 'andAll' ||
    selectiveLogicRaw === 'notAll' ||
    selectiveLogicRaw === 'notAny'
      ? selectiveLogicRaw
      : 'andAny';

  // order：无论 slot/fixed 都应是明确数字；否则丢弃该条目，避免“默默变成 0”导致意外注入。
  const order = toNumber((e as any).order, NaN);
  if (!Number.isFinite(order)) return null;

  // depth：仅 fixed 注入真正需要；slot 条目允许缺省为 0
  const depth = toNumber((e as any).depth, position === 'fixed' ? NaN : 0);
  if (position === 'fixed' && !Number.isFinite(depth)) return null;

  const roleRaw = (e as any).role;
  const role =
    roleRaw === null
      ? null
      : String(roleRaw || '') === ''
        ? null
        : (String(roleRaw) as any);

  const caseSensitive =
    (e as any).caseSensitive === null || typeof (e as any).caseSensitive === 'boolean'
      ? (e as any).caseSensitive
      : null;

  const excludeRecursion = toBool((e as any).excludeRecursion, false);
  const preventRecursion = toBool((e as any).preventRecursion, false);

  const probability = toNumber((e as any).probability, 100);

  const other = (e as any).other && typeof (e as any).other === 'object' ? (e as any).other : {};

  return {
    index,
    name,
    content,
    enabled,
    activationMode,
    key,
    secondaryKey,
    selectiveLogic,
    order,
    depth,
    position,
    role,
    caseSensitive,
    excludeRecursion,
    preventRecursion,
    probability,
    other,
  };
}

function normalizeOne(item: WorldBookInput): WorldBookEntry[] {
  // 直接是 entries 数组
  if (isWorldBookEntryArray(item)) {
    return (item as any[]).map(normalizeOneEntry).filter((x): x is WorldBookEntry => Boolean(x));
  }

  // 形如 { name, entries } 的 worldbook.json
  if (typeof item === 'object' && item !== null && Array.isArray((item as any).entries)) {
    // 允许 { enabled: false } 作为文件级开关
    if ((item as any).enabled === false) return [];
    return ((item as any).entries as any[]).map(normalizeOneEntry).filter((x): x is WorldBookEntry => Boolean(x));
  }

  return [];
}

/**
 * 兼容一次性传入多个“世界书 JSON 文件”（多文件）：
 * - WorldBook（{ name, entries }）
 * - WorldBookEntry[]
 * - 以上任意形式的数组（多文件）
 */
export function normalizeWorldbooks(input?: WorldBooksInput): WorldBookEntry[] {
  if (!input) return [];

  // 关键点：
  // - input 既可能是“单个文件的 entries 数组（WorldBookEntry[]）”
  // - 也可能是“多个文件的数组（WorldBookInput[]）”
  // 两者在运行时都是 Array，需要用内容结构区分。
  const files: WorldBookInput[] = [];

  if (Array.isArray(input)) {
    if (isWorldBookEntryArray(input)) {
      files.push(input);
    } else {
      files.push(...(input as WorldBookInput[]));
    }
  } else {
    files.push(input);
  }

  const out: WorldBookEntry[] = [];
  for (const file of files) {
    if (!file) continue;
    out.push(...normalizeOne(file));
  }
  return out;
}

