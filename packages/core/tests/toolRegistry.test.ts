import { RuntimeToolRegistry, type RuntimeTool } from '../src/runtime/tools';

function tool(type = 'string'): RuntimeTool {
  return { declaration: { name: 'mcp__sample', description: '测试工具',
    parameters: { type: 'object', properties: { value: { type } }, required: ['value'] } },
    effects: () => ['public_read'], execute: async () => ({ success: true }) };
}

test.each([undefined, 'https://json-schema.org/draft/2020-12/schema'])('组合和引用 Schema 的合法空值不会被当作可选占位删除：%s', dialect => {
  const registry = new RuntimeToolRegistry();
  const input = tool();
  input.declaration.parameters = { type: 'object', properties: { byRef: { type: 'string' }, omitted: { type: 'string' } } };
  input.validationSchema = { $id: 'https://example.test/nullable-tool.json', ...(dialect ? { $schema: dialect } : {}), type: 'object',
    $defs: { nullable: { type: ['string', 'null'] } },
    properties: {
      byRef: { $ref: '#/$defs/nullable' }, later: { $ref: '#/$defs/nullable' },
      combined: { allOf: [{ $ref: '#/$defs/nullable' }, { not: { const: 'excluded' } }] },
      unconstrained: {}, omitted: { type: 'string' },
      nested: { type: 'object', properties: { 'a/b~c': { $ref: '#/$defs/nullable' }, omitted: { type: 'number' } } },
      list: { type: 'array', items: { type: 'object', properties: { value: { $ref: '#/$defs/nullable' }, omitted: { type: 'string' } } } },
      ambiguous: { oneOf: [{ type: 'null' }, { const: null }] },
    } };
  registry.register(input);
  const old = registry.catalog(['mcp__sample']).entries.get('mcp__sample')!;
  const args = { byRef: null, combined: null, unconstrained: null, omitted: null,
    nested: { 'a/b~c': null, omitted: null }, list: [{ value: null, omitted: null }] };
  const normalized = old.normalizeArguments(args);
  expect(normalized).toEqual({ byRef: null, combined: null, unconstrained: null, nested: { 'a/b~c': null }, list: [{ value: null }] });
  expect(args.nested.omitted).toBeNull();
  expect(old.validate(normalized)).toBe(true);
  expect(old.normalizeArguments({ ambiguous: null })).toEqual({ ambiguous: null });
  expect(old.validate({ ambiguous: null })).toBe(false);
  expect(registry.catalog(['mcp__sample']).entries.get('mcp__sample')!.normalizeArguments).toBe(old.normalizeArguments);
  input.validationSchema.$defs = { nullable: { type: 'string' } };
  registry.replaceNamespace('mcp__', [input]);
  const current = registry.catalog(['mcp__sample']).entries.get('mcp__sample')!;
  expect(current.normalizeArguments({ later: null })).toEqual({});
  // 旧目录首次解析另一条引用路径时，也必须继续使用捕获的旧 Schema。
  expect(old.normalizeArguments({ later: null })).toEqual({ later: null });
});

test('同步工具入口拒绝把异步 Schema 的 Promise 当作校验成功', () => {
  const registry = new RuntimeToolRegistry();
  const input = tool(); input.validationSchema = { ...input.declaration.parameters, $async: true };
  registry.register(input);
  expect(() => registry.catalog(['mcp__sample'])).toThrow('不支持异步 Schema');
});

test('重复捕获相同工具目录复用校验器，并保持声明和版本稳定', () => {
  const registry = new RuntimeToolRegistry(); registry.register(tool());
  const original = registry.catalog(['mcp__sample']);
  for (let i = 0; i < 100; i++) {
    const next = registry.catalog(['mcp__sample']);
    expect(next.version).toBe(original.version);
    expect(next.declarations).toEqual(original.declarations);
    expect(next.entries.get('mcp__sample')!.validate).toBe(original.entries.get('mcp__sample')!.validate);
  }
});

test('工具替换与卸载不会改变已捕获目录的参数校验', () => {
  const registry = new RuntimeToolRegistry(); registry.register(tool());
  const names = registry.names();
  const previous = registry.catalog(['mcp__sample']);
  registry.replaceNamespace('mcp__', [tool('number')]);
  const next = registry.catalog(['mcp__sample']);
  expect(next.version).not.toBe(previous.version);
  expect(next.entries.get('mcp__sample')!.validate({ value: 2 })).toBe(true);
  expect(next.entries.get('mcp__sample')!.validate({ value: '2' })).toBe(false);
  registry.replaceNamespace('mcp__', []);
  expect(names).toEqual(['mcp__sample']);
  expect(registry.names()).toEqual([]);
  expect(() => registry.catalog(['mcp__sample'])).toThrow('unavailable');
  expect(previous.entries.get('mcp__sample')!.validate({ value: '旧任务' })).toBe(true);
  expect(previous.entries.get('mcp__sample')!.validate({ value: 2 })).toBe(false);
});

test('相同内容的运行时替换复用校验器，声明变化才重新编译', () => {
  const registry = new RuntimeToolRegistry(); registry.register(tool());
  const original = registry.catalog(['mcp__sample']);
  const unchanged = registry.catalog(['mcp__sample'], new Map([['mcp__sample', tool()]]));
  const changed = registry.catalog(['mcp__sample'], new Map([['mcp__sample', tool('number')]]));
  expect(unchanged.entries.get('mcp__sample')!.validate).toBe(original.entries.get('mcp__sample')!.validate);
  expect(changed.entries.get('mcp__sample')!.validate).not.toBe(original.entries.get('mcp__sample')!.validate);
});

test('模型声明的兼容处理不会放宽执行校验，原始约束变化也更新目录版本', () => {
  const registry = new RuntimeToolRegistry();
  const input = tool();
  input.validationSchema = { ...input.declaration.parameters, additionalProperties: false };
  registry.register(input);
  // 注册后调用方再修改原对象，不应改变已经登记的执行约束。
  input.validationSchema.additionalProperties = true;
  const before = registry.catalog(['mcp__sample']);
  expect(before.declarations[0].parameters).not.toHaveProperty('additionalProperties');
  expect(before.entries.get('mcp__sample')!.validate({ value: 'ok', extra: true })).toBe(false);
  expect(registry.catalog(['mcp__sample']).entries.get('mcp__sample')!.validate).toBe(before.entries.get('mcp__sample')!.validate);
  registry.replaceNamespace('mcp__', [input]);
  const after = registry.catalog(['mcp__sample']);
  expect(after.declarations).toEqual(before.declarations);
  expect(after.version).not.toBe(before.version);
  expect(after.entries.get('mcp__sample')!.validate({ value: 'ok', extra: true })).toBe(true);
  expect(before.entries.get('mcp__sample')!.validate({ value: 'ok', extra: true })).toBe(false);
});

test('命名空间替换只重建 Schema 变化的校验器，并释放已移除名称的校验器', () => {
  const named = (name: string, type = 'string'): RuntimeTool => ({ ...tool(type), declaration: { ...tool(type).declaration, name } });
  const registry = new RuntimeToolRegistry();
  registry.replaceNamespace('mcp__', [named('mcp__a__same'), named('mcp__a__changed'), named('mcp__b__removed')]);
  const before = registry.catalog(['mcp__a__same', 'mcp__a__changed', 'mcp__b__removed']);
  expect(registry.diagnostics().compiledToolSchemas).toBe(3);
  registry.replaceNamespace('mcp__', [named('mcp__a__same'), named('mcp__a__changed', 'number')]);
  // 已移除与 Schema 变化的名称在替换时就释放，不等待下一次捕获。
  expect(registry.diagnostics().compiledToolSchemas).toBe(1);
  const after = registry.catalog(['mcp__a__same', 'mcp__a__changed']);
  expect(after.entries.get('mcp__a__same')!.validate).toBe(before.entries.get('mcp__a__same')!.validate);
  expect(after.entries.get('mcp__a__changed')!.validate).not.toBe(before.entries.get('mcp__a__changed')!.validate);
  expect(after.entries.get('mcp__a__changed')!.validate({ value: 2 })).toBe(true);
  expect(before.entries.get('mcp__a__changed')!.validate({ value: 2 })).toBe(false);
  expect(() => registry.catalog(['mcp__b__removed'])).toThrow('unavailable');
  // 重新加入同名工具时重新编译，不会拿到已释放的旧校验器。
  registry.replaceNamespace('mcp__', [named('mcp__a__same'), named('mcp__b__removed')]);
  expect(registry.catalog(['mcp__b__removed']).entries.get('mcp__b__removed')!.validate).not.toBe(before.entries.get('mcp__b__removed')!.validate);
  expect(registry.catalog(['mcp__a__same']).entries.get('mcp__a__same')!.validate).toBe(before.entries.get('mcp__a__same')!.validate);
});

test.each([
  ['http://json-schema.org/draft-06/schema#', { type: 'number', exclusiveMinimum: 0 }, 1, 0],
  ['http://json-schema.org/draft-07/schema#', { type: 'array', items: [{ type: 'string' }], additionalItems: false }, ['ok'], [1]],
  ['https://json-schema.org/draft/2019-09/schema', { type: 'object', properties: { a: {}, b: {} }, dependentRequired: { a: ['b'] } }, { a: 1, b: 2 }, { a: 1 }],
  ['https://json-schema.org/draft/2020-12/schema', { type: 'array', prefixItems: [{ type: 'string' }], items: false }, ['ok'], [1]],
] as const)('按声明的 Schema 版本校验参数：%s', (dialect, shape, valid, invalid) => {
  const registry = new RuntimeToolRegistry();
  const input = tool();
  input.validationSchema = { type: 'object', $schema: dialect, properties: { value: shape }, required: ['value'] };
  registry.register(input);
  const validate = registry.catalog(['mcp__sample']).entries.get('mcp__sample')!.validate;
  expect(validate({ value: valid })).toBe(true);
  expect(validate({ value: invalid })).toBe(false);
});
