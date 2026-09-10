interface PrivateField { path: string[]; value: unknown }
export interface SealedFieldsRecord { sealedFieldsRef?: string }
const sensitiveName = /^(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie)$/i;

function privateUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!(url.username || url.password) || [...url.searchParams.entries()].some(([key, val]) =>
      val !== '' && !/^\{[^}]+\}$/.test(val) && (sensitiveName.test(key) || /^(key|sig|signature)$/i.test(key)));
  } catch { return false; }
}

/** Encrypt selected field values together; ordinary presets remain compressible/deduplicated. */
export function sealSettingsFields<T extends object>(input: T, reference: string): { value: T & SealedFieldsRecord; credentials: Record<string, string | null> } {
  const value = structuredClone(input) as T & SealedFieldsRecord;
  delete value.sealedFieldsRef;
  const fields: PrivateField[] = [];
  const visit = (object: Record<string, unknown>, path: string[]): void => {
    for (const [key, item] of Object.entries(object)) {
      const populated = item !== undefined && item !== null && item !== '' &&
        (typeof item !== 'object' || Object.keys(item).length > 0);
      const customBody = key === 'customBody' && typeof item === 'object' && item !== null &&
        (!Object.hasOwn(item, 'mode') || (item as { json?: string }).json || (item as { items?: unknown[] }).items?.length);
      if (populated && (sensitiveName.test(key) || key === 'customHeaders' || customBody || privateUrl(item))) {
        fields.push({ path: [...path, key], value: item }); delete object[key];
      } else if (item && typeof item === 'object') visit(item as Record<string, unknown>, [...path, key]);
    }
  };
  visit(value as Record<string, unknown>, []);
  if (fields.length) value.sealedFieldsRef = reference;
  return { value, credentials: { [reference]: fields.length ? JSON.stringify(fields) : null } };
}

export async function revealSettingsFields<T extends object>(input: T & SealedFieldsRecord, credential: (reference: string) => Promise<string | null>): Promise<T> {
  const value = structuredClone(input);
  const reference = value.sealedFieldsRef;
  delete value.sealedFieldsRef;
  if (!reference) return value;
  const encoded = await credential(reference);
  if (encoded === null) throw new Error('无法读取已加密的设置字段。');
  for (const field of JSON.parse(encoded) as PrivateField[]) {
    if (!Array.isArray(field.path) || !field.path.length) throw new Error('加密设置字段路径无效。');
    let parent = value as Record<string, unknown>;
    for (const key of field.path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== 'object') throw new Error('加密设置字段的父级不存在。');
      parent = parent[key] as Record<string, unknown>;
    }
    Object.defineProperty(parent, field.path.at(-1)!, { value: field.value, configurable: true, enumerable: true, writable: true });
  }
  return value;
}
