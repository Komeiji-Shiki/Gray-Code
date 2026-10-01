import type { RuntimeTool, ToolContext } from "@graycode/core";
import { stat } from 'node:fs/promises';
import { WorkspaceFiles } from "./files";
import { getActualLanguage, t } from '../../../../backend/i18n';
import { resolveLocalizationLanguage } from '../../../../backend/tools/localization/types';
import { WorkspaceProcesses, commandEffects, ProcessSessionError, type ProcessOwner, type ProcessResult } from "./processes";
import type { ToolOutcome } from '@graycode/contracts';
import type { WorkspaceChanges } from './changes';
import { splitTextLines } from '../../../../shared/textLines';

function workspace(context: ToolContext) {
  if (!context.workspace)
    throw new Error("Select a workspace before using local tools.");
  return context.workspace;
}
// 身份只来自运行器，不能让模型参数选择账号、对话或工作区来接管其他进程。
function processOwner(context: ToolContext): ProcessOwner {
  return { actorId: context.actorId, conversationId: context.conversationId,
    runId: context.runId, workspaceId: context.workspace?.id };
}
function processOutcome(data: ProcessResult, stopped = false): ToolOutcome {
  // 进程会话只有 read/input/stop；退出且没有未读输出时，不再给出等待建议。
  // 服务返回的是本次查询的独立快照，在原结果上补提示，保留既有调用方持有的结果引用。
  const result = Object.assign(data, data.running || data.hasMore ? { nextActions: [{
    tool: 'process_session', args: { action: 'read', id: data.id, cursor: data.nextCursor },
    when: t(data.hasMore ? 'tools.terminal.nextActions.processMoreOutput' : 'tools.terminal.nextActions.processIntermediateOutput'),
  }] } : {});
  // stop 的成功表示停止请求已完成；运行中或无退出码不推断成命令失败。
  return !stopped && !data.running && typeof data.exitCode === 'number' && data.exitCode !== 0
    ? { success: false, code: 'COMMAND_EXIT_NONZERO', error: `Command exited with code ${data.exitCode}`, data: result }
    : { success: true, data: result };
}
const optionalText = { type: "string" };
export function workspaceTools(
  files: WorkspaceFiles,
  processes: WorkspaceProcesses,
  changes: WorkspaceChanges,
): RuntimeTool[] {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return [
    {
      declaration: {
        name: "workspace_files",
        description: isZh
          ? '带哈希校验地读写工作区文本文件，只在需要显式校验写入时使用。普通代码阅读、批量读取和图片/PDF 用 read_file，需要 Diff 审阅的局部修改用 apply_diff，新建或重写用 write_file。先用本工具 read 获取原文哈希；write、edit、delete 必须传 expectedHash（新建文件传 null），文件有未保存的草稿或已被修改时会拒绝。edit 只替换唯一出现的 oldText。'
          : 'Read and write workspace text files with hash checks. Use it only when you need an explicitly hash-checked write; use read_file for ordinary reading, batches and images/PDFs, apply_diff for targeted edits that need Diff review, and write_file for new files or rewrites. Call read here first to get the hash. write, edit and delete require expectedHash (null for a new file) and are rejected if the file has an unsaved draft or has changed. edit replaces exactly one occurrence of oldText.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["list", "read", "write", "edit", "delete"],
            },
            path: { type: "string" },
            content: optionalText,
            oldText: optionalText,
            newText: optionalText,
            expectedHash: { type: ["string", "null"] },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["action", "path"],
        },
      },
      effects: (args) =>
        args.action === "delete"
          ? ["workspace_write", "data_delete"]
          : ["write", "edit"].includes(String(args.action))
            ? ["workspace_write"]
            : ["workspace_read"],
      parallelRead: true,
      nativeAsync: false,
      execute: async (args, context) => {
        const target = workspace(context);
        const file = String(args.path);
        if (args.action === "list")
          return { success: true, data: await files.list(target, file) };
        if (args.action === "read") {
          const value = await files.read(target, file);
          if (value.hash === null)
            return {
              success: false,
              code: "NOT_FOUND",
              error: "File does not exist.",
            };
          const lines = splitTextLines(value.text, true);
          const start = Math.max(0, Number(args.startLine ?? 1) - 1);
          if (start >= lines.length)
            return {
              success: false,
              code: "INVALID_LINE_RANGE",
              error: `startLine (${start + 1}) exceeds total lines (${lines.length})`,
              data: { totalLines: lines.length },
            };
          const end = Math.max(start + 1, Math.min(
            lines.length,
            Number(args.endLine ?? start + 300),
            start + 1200,
          ));
          return {
            success: true,
            data: {
              hash: value.hash,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
              content: lines.slice(start, end).join("").replace(/(?:\r\n|\r|\n)$/, ""),
            },
          };
        }
        if (!Object.hasOwn(args, "expectedHash"))
          throw new Error(
            "Supply the hash returned by read, or null when creating a new file.",
          );
        if (args.action === "delete") {
          if (typeof args.expectedHash !== "string")
            throw new Error("Read the existing file before deletion.");
          await changes.write(context, [{ path: file, text: null, expectedHash: args.expectedHash }]);
          return { success: true };
        }
        let content = args.content;
        if (args.action === "edit") {
          if (
            typeof args.oldText !== "string" ||
            !args.oldText ||
            typeof args.newText !== "string"
          )
            throw new Error("Supply nonempty oldText and replacement newText.");
          const current = await files.read(target, file);
          if (current.hash !== args.expectedHash)
            throw new Error("FILE_CONFLICT: Re-read the file before editing.");
          const offset = current.text.indexOf(args.oldText);
          if (
            offset < 0 ||
            current.text.indexOf(args.oldText, offset + 1) !== -1
          )
            throw new Error(
              "oldText must match exactly one occurrence. Include more context.",
            );
          content =
            current.text.slice(0, offset) +
            args.newText +
            current.text.slice(offset + args.oldText.length);
        }
        if (typeof content !== "string")
          throw new Error("Supply the file content.");
        return {
          success: true,
          data: await changes.write(context, [{ path: file, text: content, expectedHash: args.expectedHash as string | null }]),
        };
      },
    },
    {
      declaration: {
        name: "run_command",
        description: isZh
          ? '直接启动可执行文件并传入 args 数组，不经过 Shell，因此不会解析管道、重定向，也不展开环境变量。参数已经分开时优先用它，可以避免命令字符串的转义问题；需要 Shell 语法、指定 Shell 或后台完成通知时改用 execute_command。返回的会话 ID 交给 process_session 读取输出、发送输入或停止，在同一账号、对话和工作区的后续运行中仍然有效。'
          : 'Start an executable directly with an args array. No shell is involved, so pipes and redirection are not parsed and environment variables are not expanded. Prefer it when the arguments are already separated, to avoid shell quoting problems; use execute_command when you need shell syntax, a specific shell or a background completion notice. Pass the returned session ID to process_session to read output, send input or stop; it stays valid in later runs of the same account, conversation and workspace.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string", minLength: 1 },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string", description: isZh ? '工作区内的启动目录，省略时为工作区根目录。工作区外的路径或指向工作区外的符号链接会被拒绝。' : 'Working directory inside the workspace; defaults to the workspace root. Paths outside the workspace, or symlinks pointing outside it, are rejected.' },
          },
          required: ["command", "args"],
        },
      },
      effects: commandEffects,
      execute: async (args, context) => {
        const target = workspace(context);
        // 与文件工具共用真实路径授权，不能仅拼接 cwd 后交给 spawn；文件路径也不能当目录启动。
        // 多根的相对路径必须带根前缀，但默认启动位置仍沿用旧版 workspace.directory。
        // 先展开默认值再校验，避免省略 cwd 时把 '.' 误判为缺少工作区前缀。
        const requestedCwd = String(args.cwd ?? '');
        const cwd = await files.resolve(target, requestedCwd === '' || requestedCwd === '.' ? target.directory : requestedCwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory within the workspace.');
        return processOutcome(await processes.start(target, processOwner(context), String(args.command), args.args as string[],
          (text) => context.progress({ text }), { cwd }));
      },
    },
    {
      declaration: {
        name: "process_session",
        description: isZh
          ? '读取输出、发送输入或停止 run_command 创建的会话。id 必须来自同一账号、对话和工作区中的 run_command，在后续运行中仍然有效；execute_command 的后台 taskId 不能用在这里。stop 只终止该会话管理的进程树。read 可用 cursor 和 maxChars 按 UTF-16 绝对字符位置分段读取，都省略时返回全部保留的输出。结果中 outputOffset 是本次输出的起点，nextCursor 是下次读取的位置，hasMore 表示还有未读输出，outputLost 表示 cursor 早于保留范围、较早的输出已被丢弃。'
          : 'Read output from, send input to, or stop a session created by run_command. The id must come from run_command in the same account, conversation and workspace, and stays valid in later runs; execute_command background taskIds do not work here. stop ends only the process tree managed by that session. For read, cursor and maxChars page by absolute UTF-16 character position; omit both to get all retained output. In the result, outputOffset is where this output starts, nextCursor is the position to read next, hasMore means unread output remains, and outputLost means the cursor was older than the retained buffer, so earlier output was discarded.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["read", "input", "stop"] },
            id: { type: "string" },
            text: optionalText,
            cursor: { type: 'integer', minimum: 0, description: isZh ? '仅用于 read：上次返回的 nextCursor。' : 'read only: the nextCursor from the previous read.' },
            maxChars: { type: 'integer', minimum: 1, maximum: 256000, description: isZh ? '仅用于 read：本次最多返回的 UTF-16 字符数。' : 'read only: maximum number of UTF-16 characters to return.' },
          },
          required: ["action", "id"],
        },
      },
      effects: (args) =>
        args.action === "read"
          ? ["workspace_read"]
          : args.action === "input"
            ? ["process_execute", "high_risk"]
            : ["process_execute"],
      execute: async (args, context) => {
        const owner = processOwner(context);
        try {
          if (args.action === "input") {
            if (typeof args.text !== "string") throw new Error("Supply process input.");
            // 授权可能查询旧运行记录，必须等待 input 完成，不能把异步拒绝丢到工具结果之后。
            await processes.input(String(args.id), owner, args.text);
          }
          if (args.action === "stop") await processes.stop(String(args.id), owner);
          return processOutcome(await processes.read(String(args.id), owner, args.action === 'read'
            ? { cursor: args.cursor as number | undefined, maxChars: args.maxChars as number | undefined } : undefined), args.action === 'stop');
        } catch (error) {
          // 运行器会把普通异常统一成 TOOL_FAILED；这些可恢复状态需要保留明确错误码供模型决策。
          if (error instanceof ProcessSessionError) return { success: false, code: error.code, error: error.message,
            ...(['EXITED', 'INPUT_CLOSED', 'INVALID_CURSOR'].includes(error.code) ? { data: { id: String(args.id), nextActions: [{
              tool: 'process_session', args: { action: 'read', id: String(args.id) },
              when: t('tools.terminal.nextActions.processInspect'),
            }] } } : {}) };
          throw error;
        }
      },
    },
  ];
}
