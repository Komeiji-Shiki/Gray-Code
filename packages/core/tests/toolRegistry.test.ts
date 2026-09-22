import { RuntimeToolRegistry, type RuntimeTool } from '../src/runtime/tools';

function tool(type = 'string'): RuntimeTool {
  return { declaration: { name: 'mcp__sample', description: '测试工具',
    parameters: { type: 'object', properties: { value: { type } }, required: ['value'] } },
    effects: () => ['public_read'], execute: async () => ({ success: true }) };
}

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
  const previous = registry.catalog(['mcp__sample']);
  registry.replaceNamespace('mcp__', [tool('number')]);
  const next = registry.catalog(['mcp__sample']);
  expect(next.version).not.toBe(previous.version);
  expect(next.entries.get('mcp__sample')!.validate({ value: 2 })).toBe(true);
  expect(next.entries.get('mcp__sample')!.validate({ value: '2' })).toBe(false);
  registry.replaceNamespace('mcp__', []);
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

