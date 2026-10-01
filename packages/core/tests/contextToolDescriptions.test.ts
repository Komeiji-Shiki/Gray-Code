import type { PlatformApplication } from '../../../apps/server/src/application';
import { contextTools } from '../../../apps/server/src/context/tools';

test('上下文工具说明直接描述用途，参数和只读语义保持兼容', () => {
  const tools = contextTools({} as PlatformApplication);
  const status = tools.find(tool => tool.declaration.name === 'context_status')!;
  // 说明要告诉模型返回的是本地估算的用量、上限与阈值及管理方式，而不只是一个标题。
  for (const phrase of ['本地估算', 'token', '输入上限', '阈值', '不含本次工具结果', '管理方式']) expect(status.declaration.description).toContain(phrase);
  expect(status.declaration.parameters).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  expect(status.parallelRead).toBe(true); expect(status.effects({})).toEqual([]);
  const next = tools.find(tool => tool.declaration.name === 'new_context')!;
  expect(next.declaration.description).toContain('笔记管理');
  expect(next.declaration.description).toContain('继续当前任务');
  expect(tools.map(tool => tool.declaration.description).join('\n')).not.toContain('换窗');
});
