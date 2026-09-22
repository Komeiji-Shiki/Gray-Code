const schemaMapKeywords = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependencies', 'dependentSchemas']);
const schemaValueKeywords = new Set(['items', 'prefixItems', 'additionalItems', 'contains', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'contentSchema']);

/** 模型接口的兼容声明。只遍历 Schema 节点，保留同名参数和示例中的普通数据。 */
export function cleanToolSchemaForModel<T>(schema: T): T {
  const result = structuredClone(schema);
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    delete node.$schema;
    delete node.additionalProperties;
    for (const [keyword, child] of Object.entries(node)) {
      if (schemaMapKeywords.has(keyword) && child && typeof child === 'object' && !Array.isArray(child)) {
        Object.values(child).forEach(visit);
      } else if (schemaValueKeywords.has(keyword)) {
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    }
  }
  visit(result);
  return result;
}
