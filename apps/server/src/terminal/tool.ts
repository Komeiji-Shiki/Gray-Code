import type { RuntimeTool } from '@graycode/core';
import type { PlatformTerminals } from './service';
import { ProcessSessionError } from '../workspace/processes';
import { t } from '../../../../backend/i18n';

export function terminalTaskTool(terminals: PlatformTerminals): RuntimeTool {
  return {
    declaration: { name: 'terminal_task', description: '管理 execute_command 启动的后台任务。list 列出本会话在当前账号和工作区下的任务；status 查看运行状态和退出码；read 从 cursor 处读取新增输出（按 UTF-16 字符位置），下次传入返回的 nextCursor，outputLost 表示较早的输出已被丢弃；stop 终止任务的进程，不会重新执行命令。同一会话的后续运行仍可使用原 taskId。任务完成会自动通知，一般无需查询，只在诊断或需要中间输出时读取。本工具调用成功不代表命令成功，请看 exitCode 和 error。run_command 的会话请用 process_session。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'status', 'read', 'stop'] }, taskId: { type: 'string', minLength: 1 },
        cursor: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 256000, default: 12000 },
        offset: { type: 'integer', minimum: 0, description: 'list 的分页位置，传入上次返回的 nextOffset 即可读取下一页。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      }, required: ['action'], additionalProperties: false } },
    parallelRead: args => args.action !== 'stop',
    effects: args => args.action === 'stop' ? ['process_execute'] : ['workspace_read'],
    execute: async (args, context) => {
      try { return await terminals.manageTask(args, context); }
      catch (error) {
        if (error instanceof ProcessSessionError) return { success: false, code: error.code, error: error.message,
          ...(error.code === 'INVALID_CURSOR' ? { data: { taskId: args.taskId, nextActions: [{
            tool: 'terminal_task', args: { action: 'read', taskId: args.taskId },
            when: t('tools.terminal.nextActions.terminalResetCursor'),
          }] } } : {}) };
        throw error;
      }
    },
  };
}
