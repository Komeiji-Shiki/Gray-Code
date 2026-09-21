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
