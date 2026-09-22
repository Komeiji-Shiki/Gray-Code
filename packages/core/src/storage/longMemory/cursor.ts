import { invalid } from '../../errors';

export interface MemoryCursor { offset: number; asOf: number; knownAt: number; fingerprint: string }
export function readMemoryCursor(value?: string): MemoryCursor | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) invalid('记忆续页编号无效。');
  let fields: unknown;
  try { fields = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { invalid('记忆续页编号无效。'); }
  if (!Array.isArray(fields) || fields.length !== 4 || !Number.isSafeInteger(fields[0]) || fields[0] < 0
    || !Number.isFinite(fields[1]) || !Number.isFinite(fields[2]) || typeof fields[3] !== 'string') invalid('记忆续页编号无效。');
  return { offset: fields[0], asOf: fields[1], knownAt: fields[2], fingerprint: fields[3] };
}
export function writeMemoryCursor(value: MemoryCursor): string {
  return Buffer.from(JSON.stringify([value.offset, value.asOf, value.knownAt, value.fingerprint])).toString('base64url');
}
