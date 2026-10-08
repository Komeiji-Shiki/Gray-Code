/** 去掉严格协议为可选字段补出的 null，保留工具原始 Schema 接受的空值。 */
export function normalizeToolArguments(value: Record<string, unknown>, schema: Record<string, unknown>,
  allowsNullAt: (pointer: string) => boolean): Record<string, unknown> {
  const acceptsNull = (shape: Record<string, unknown>): boolean => shape.type === 'null'
    || (Array.isArray(shape.type) && shape.type.includes('null'))
    || (Array.isArray(shape.enum) && shape.enum.includes(null))
    || shape.const === null
    || shape.nullable === true
    // 组合分支显式允许的空值必须保留，分支是否唯一匹配继续交给正式 Schema 校验。
    || [shape.anyOf, shape.oneOf].some(branches => Array.isArray(branches)
      && branches.some(item => item && typeof item === 'object' && acceptsNull(item as Record<string, unknown>)));
  function visit(input: unknown, shape: Record<string, unknown>, pointer: string): unknown {
    if (Array.isArray(input) && shape.items && typeof shape.items === 'object')
      return input.map(item => visit(item, shape.items as Record<string, unknown>, `${pointer}/items`));
    if (!input || typeof input !== 'object' || Array.isArray(input) || !shape.properties || typeof shape.properties !== 'object') return input;
    const properties = shape.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(shape.required) ? shape.required : [];
    return Object.fromEntries(Object.entries(input).flatMap(([key, item]) => {
      const property = properties[key];
      if (!property || typeof property !== 'object') return [[key, item]];
      const propertyPointer = `${pointer}/properties/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (item === null && !required.includes(key) && !acceptsNull(property)) {
        // 直接类型即可排除的情况不重复编译；引用和组合约束交给正式校验器判断。
        const excludesNull = !property.$ref && (property.type !== undefined || Array.isArray(property.enum) || 'const' in property);
        if (excludesNull || !allowsNullAt(propertyPointer)) return [];
      }
      return [[key, visit(item, property, propertyPointer)]];
    }));
  }
  return visit(value, schema, '') as Record<string, unknown>;
}
