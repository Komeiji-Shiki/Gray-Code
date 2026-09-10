/** Undo wire-only nullable optional fields used by strict provider schemas, preserving real nullable fields. */
export function normalizeToolArguments(value: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const acceptsNull = (shape: Record<string, unknown>): boolean => shape.type === 'null'
    || (Array.isArray(shape.type) && shape.type.includes('null'))
    || (Array.isArray(shape.enum) && shape.enum.includes(null))
    || (Array.isArray(shape.anyOf) && shape.anyOf.some(item => item && typeof item === 'object' && acceptsNull(item as Record<string, unknown>)));
  function visit(input: unknown, shape: Record<string, unknown>): unknown {
    if (Array.isArray(input) && shape.items && typeof shape.items === 'object') return input.map(item => visit(item, shape.items as Record<string, unknown>));
    if (!input || typeof input !== 'object' || Array.isArray(input) || !shape.properties || typeof shape.properties !== 'object') return input;
    const properties = shape.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(shape.required) ? shape.required : [];
    return Object.fromEntries(Object.entries(input).flatMap(([key, item]) => {
      const property = properties[key];
      if (!property || typeof property !== 'object') return [[key, item]];
      if (item === null && !required.includes(key) && !acceptsNull(property)) return [];
      return [[key, visit(item, property)]];
    }));
  }
  return visit(value, schema) as Record<string, unknown>;
}
