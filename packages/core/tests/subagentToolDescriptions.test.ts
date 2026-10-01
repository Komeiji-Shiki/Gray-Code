import type { PlatformApplication } from '../../../apps/server/src/application';
import { subagentTools } from '../../../apps/server/src/subagents/tools';
import { MAX_HOP_DEPTH } from '../../../backend/core/services/agentMessages';

const appWithLanguage = (language?: string) => ({
  product: { runtimeSettings: () => ({ getUISettings: () => (language ? { language } : {}) }) },
}) as unknown as PlatformApplication;
const declarations = (language?: string) => Object.fromEntries(subagentTools(appWithLanguage(language))
  .map(tool => [tool.declaration.name, tool.declaration]));
const property = (declaration: { parameters: Record<string, unknown> }, name: string) =>
  (declaration.parameters.properties as Record<string, { description?: string }>)[name].description ?? '';

test.each([['zh-CN', /[\u4e00-\u9fff]/], ['en', /^[^\u4e00-\u9fff]*$/]] as const)('子代理与消息工具说明跟随界面语言 %s', (language, pattern) => {
  const { subagents, agent_send_message: send } = declarations(language);
  for (const text of [subagents.description, property(subagents, 'background'), property(subagents, 'agentName'),
    send.description, property(send, 'threadId'), property(send, 'targetRunId')]) expect(text).toMatch(pattern);
});

test('线程跳数限制直接写在 threadId 参数里，不引用不存在的段落', () => {
  for (const language of ['zh-CN', 'en']) {
    const { subagents, agent_send_message: send } = declarations(language);
    const threadId = property(send, 'threadId');
    expect(threadId).toContain(String(MAX_HOP_DEPTH));
    expect(threadId).not.toMatch(/见上方|see .*above/i);
    // 后台取消只在主说明中描述一次；参数说明只保留后台启动和 taskId 的含义。
    expect(property(subagents, 'background')).toContain('taskId');
    expect(property(subagents, 'background')).not.toMatch(/取消|cancel|任务栏|task bar/i);
    expect(subagents.description).toMatch(/不会随当前任务取消|not cancelled with the current task/);
    expect(`${subagents.description}\n${send.description}`).not.toMatch(/运行监视器|monitor|工作台/i);
  }
  const zh = declarations('zh-CN').agent_send_message.description;
  for (const limit of ['16000', '50', '发送成功即表示消息已保存', '不会唤醒']) expect(zh).toContain(limit);
});
