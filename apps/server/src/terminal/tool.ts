import type { RuntimeTool } from '@graycode/core';
import type { PlatformTerminals } from './service';
import { ProcessSessionError } from '../workspace/processes';

export function terminalTaskTool(terminals: PlatformTerminals): RuntimeTool {
  return {
    declaration: { name: 'terminal_task', description: '管理 execute_command 的受管终端任务。list 列出当前账号、会话及工作区的任务；status 查看运行/终态；read 按 UTF-16 cursor 增量读取输出，nextCursor 用于续读，outputLost 表示旧输出已被淘汰；stop 仅停止对应任务持有的进程树，不重放命令。支持同一会话后续运行继续使用 taskId。不要传 run_command 的会话 ID（它使用 process_session）。后台完成仍自动通知，无需循环轮询；仅诊断或需要中间结果时按需读取。status/read 成功表示查询成功，命令自身状态看 status/exitCode/error。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'status', 'read', 'stop'] }, taskId: { type: 'string', minLength: 1 },
        cursor: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 256000, default: 12000 },
        offset: { type: 'integer', minimum: 0, description: 'list 的续查位置；使用 nextOffset。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      }, required: ['action'], additionalProperties: false } },
    parallelRead: args => args.action !== 'stop',
    effects: args => args.action === 'stop' ? ['process_execute'] : ['workspace_read'],
    execute: async (args, context) => {
      try { return await terminals.manageTask(args, context); }
      catch (error) { if (error instanceof ProcessSessionError) return { success: false, code: error.code, error: error.message }; throw error; }
    },
  };
}
