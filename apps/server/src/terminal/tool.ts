import type { RuntimeTool } from '@graycode/core';
import type { PlatformTerminals } from './service';
import { ProcessSessionError } from '../../../../shared/processOutput';
import { t } from '../../../../backend/i18n';

export function terminalTaskTool(terminals: PlatformTerminals): RuntimeTool {
  return {
    declaration: {
      name: 'terminal_task',
      description:
        '管理 execute_command 创建的任务，同一账号、会话和工作区的后续运行可继续使用 taskId。' +
        'list 列出任务，status 查询状态，read 从 UTF-16 绝对 cursor 处续读，下次使用 nextCursor；hasMore 表示仍有未读输出，outputLost 表示较早输出已被丢弃。' +
        'input 原样写入 stdin，stop 终止该任务的进程树。background=true 有自动完成通知，其他 argv 会话按需读取。' +
        '查询状态成功不代表命令成功，请检查 exitCode 和 error；argv 续读遇到非零退出会返回 COMMAND_EXIT_NONZERO。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'status', 'read', 'input', 'stop'] },
          taskId: { type: 'string', minLength: 1 },
          text: { type: 'string', description: '仅用于 input：原样写入的文字，提交一行时自行在末尾包含换行符（\\n）。' },
          cursor: { type: 'integer', minimum: 0 },
          maxChars: {
            type: 'integer',
            minimum: 1,
            maximum: 256000,
            description: '每次读取的 UTF-16 字符上限；Shell 任务默认 12000，argv 会话默认返回全部保留输出。',
          },
          offset: { type: 'integer', minimum: 0, description: 'list 的分页位置，传入上次返回的 nextOffset 即可读取下一页。' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    parallelRead: (args) => ['list', 'status', 'read'].includes(String(args.action)),
    approvalName: (args) => (args.action === 'input' ? 'process_session' : 'terminal_task'),
    effects: (args) =>
      args.action === 'input' ? ['process_execute', 'high_risk'] : args.action === 'stop' ? ['process_execute'] : ['workspace_read'],
    execute: async (args, context) => {
      try {
        return await terminals.manageTask(args, context);
      } catch (error) {
        if (error instanceof ProcessSessionError)
          return {
            success: false,
            code: error.code,
            error: error.message,
            ...(['INVALID_CURSOR', 'EXITED', 'INPUT_CLOSED'].includes(error.code)
              ? {
                  data: {
                    taskId: args.taskId,
                    nextActions: [
                      {
                        tool: 'terminal_task',
                        args: { action: 'read', taskId: args.taskId },
                        when: t(
                          error.code === 'INVALID_CURSOR'
                            ? 'tools.terminal.nextActions.terminalResetCursor'
                            : 'tools.terminal.nextActions.processInspect',
                        ),
                      },
                    ],
                  },
                }
              : {}),
          };
        throw error;
      }
    },
  };
}
