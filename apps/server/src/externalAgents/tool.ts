import type { RuntimeTool } from '@graycode/core';
import type { ExternalAgents } from './service';

export function externalAgentTool(service: ExternalAgents): RuntimeTool {
  return {
    declaration: {
      name: 'coding_agent',
      description:
        '在当前任务的工作区调用已配置的外部 ACP 编程代理。'
          + 'list 查看配置和会话，create 创建会话并可发送首条提示，prompt 向现有会话追加输入，load 恢复会话而不重发历史提示，fork 创建独立会话，configure 使用代理返回的模式或配置 ID，events 读取已记录的交互，close 结束本工具管理的代理进程。'
          + '后台工作仍需会话时保持开启。'
          + '前次操作结果未知时，先查询再决定是否重试。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'prompt', 'load', 'fork', 'configure', 'close', 'events'] },
          profileId: {
            type: 'string',
            description:
              'list 返回的配置 ID，用于 create；'
          + '仅启用一个配置时可省略。'
          + 'fork 继承源会话配置。',
          },
          sessionId: {
            type: 'string',
            description: 'create、fork 或 list 返回的 GrayCode session.id；'
          + '操作已有会话时必填。',
          },
          prompt: {
            type: 'string',
            description:
              '发给代理的新输入。'
          + 'prompt 时必填且非空，create 时可选。'
          + '会话保留历史，只发送新增指令。',
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '附加到本次输入的工作区相对图片路径；'
          + '会话中已有图片继续保留。',
          },
          configId: { type: 'string', description: 'configure 使用 session.configOptions 中的 ID；'
          + 'value 类型遵循该选项定义。' },
          value: {
            oneOf: [{ type: 'string' }, { type: 'boolean' }],
            description: 'configure 搭配 configId 使用的字符串或布尔值。',
          },
          modeId: {
            type: 'string',
            description: 'configure 使用 session.modes.availableModes 中的 ID。'
          + 'modeId 切换模式，configId/value 修改单个选项。',
          },
          afterSequence: {
            type: 'integer',
            minimum: 0,
            description:
              'events 读取序号大于此值的记录，每次最多 100 条。'
          + '从 0 开始；'
          + 'hasMore 为 true 时传入最后一条 event.sequence 继续。',
          },
        },
      },
    },
    effects: args =>
      ['list', 'events'].includes(String(args.action))
        ? ['workspace_read']
        : args.action === 'configure'
          ? ['process_execute', 'workspace_read', 'workspace_write', 'administration']
          : ['process_execute', 'workspace_read', 'workspace_write'],
    execute: (args, context) => service.execute(args, context),
  };
}
