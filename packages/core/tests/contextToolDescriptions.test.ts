import type { PlatformApplication } from '../../../apps/server/src/application';
import { contextTools } from '../../../apps/server/src/context/tools';

test('上下文工具说明直接描述用途，参数和只读语义保持兼容', () => {
  const tools = contextTools({} as PlatformApplication);
  const status = tools.find(tool => tool.declaration.name === 'context_status')!;
  expect(status.declaration.description).toBe('查询当前token用量与总结策略');
  expect(status.declaration.parameters).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  expect(status.parallelRead).toBe(true); expect(status.effects({})).toEqual([]);
  const next = tools.find(tool => tool.declaration.name === 'new_context')!;
  expect(next.declaration.description).toContain('笔记管理');
  expect(next.declaration.description).toContain('继续当前任务');
  expect(tools.map(tool => tool.declaration.description).join('\n')).not.toContain('换窗');
});
