import type { RuntimeTool, ToolContext } from "@graycode/core";
import { stat } from 'node:fs/promises';
import { WorkspaceFiles } from "./files";
import { getActualLanguage } from '../../../../backend/i18n';
import { resolveLocalizationLanguage } from '../../../../backend/tools/localization/types';
import { WorkspaceProcesses, commandEffects, ProcessSessionError, type ProcessOwner } from "./processes";
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
          ? '对工作区文本文件进行哈希校验读写。read 返回原文哈希；write/edit/delete 必须传 expectedHash（新文件为 null），存在未保存草稿或文件变化时拒绝修改。edit 只替换唯一的 oldText。普通代码阅读、批量读取和图片/PDF 使用 read_file；需要 Diff 审阅的局部修改使用 apply_diff，新建或重写使用 write_file。仅在需要显式哈希校验写入时选择本工具，并先用本工具 read 获取哈希。'
          : 'Hash-checked workspace text-file access. Read returns the original-text hash; write/edit/delete require expectedHash (null for a new file). Dirty drafts or external changes cause conflicts. Edit replaces exactly one oldText occurrence. Prefer read_file for ordinary code reading, batches and images/PDFs; apply_diff for targeted Diff edits and write_file for creation/rewrites. Choose this tool when explicit hash-checked writes are needed, and read here first to obtain the hash.',
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
        name: "search_files",
        description: isZh
          ? '轻量、严格字面量搜索 UTF-8 文本，每个匹配行返回一次，不自动拆分关键词。跳过符号链接、.git、node_modules、二进制和大文件。需要正则、文件 glob、上下文或替换时使用 search_in_files。结果有 nextOffset 时保持查询参数不变并传入 offset 续查；文件变化后从 0 重查。'
          : 'Lightweight strict literal search in UTF-8 files, returning each matching line once without keyword fallback. Skips symlinks, .git, node_modules and binary/large files. Use search_in_files for regex, file globs, context or replacement. Continue with nextOffset as offset and unchanged query parameters; restart at 0 after files change.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            directory: optionalText,
            caseSensitive: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            offset: { type: "integer", minimum: 0, default: 0,
              description: isZh ? '跳过的匹配行数；续查时使用上次返回的 nextOffset。' : 'Matching lines to skip; use the previous nextOffset to continue.' },
          },
          required: ["query"],
        },
      },
      parallelRead: true,
      effects: () => ["workspace_read"],
      execute: async (args, context) => {
        const target = workspace(context);
        const pending = [String(args.directory ?? ".")];
        const matches: { path: string; line: number; text: string }[] = [];
        const limit = Number(args.limit ?? 100);
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('offset must be a non-negative safe integer');
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer between 1 and 200');
        if (typeof args.query !== 'string' || !args.query.length) throw new Error('query must be nonempty text');
        const query = args.caseSensitive ? args.query : args.query.toLowerCase();
        const probeLimit = limit + 1;
        let remaining = Number(offset);
        let scanned = 0;
        let filesTruncated = false;
        search: while (pending.length && matches.length < probeLimit) {
          context.signal.throwIfAborted();
          for (const entry of await files.list(target, pending.pop()!)) {
            if (entry.kind === "directory") {
              if (![".git", "node_modules"].includes(entry.name)) pending.push(entry.path);
              continue;
            }
            if (entry.kind !== "file") continue;
            if (scanned >= 20_000) { filesTruncated = true; break search; }
            scanned++;
            let text: string;
            try {
              text = (await files.read(target, entry.path)).text;
            } catch {
              context.signal.throwIfAborted();
              continue;
            }
            for (const [line, value] of splitTextLines(text).entries()) {
              if (!(args.caseSensitive ? value : value.toLowerCase()).includes(query)) continue;
              if (remaining > 0) { remaining--; continue; }
              matches.push({ path: entry.path, line: line + 1, text: value.slice(0, 1200) });
              if (matches.length >= probeLimit) break search;
            }
          }
        }
        const matchesTruncated = matches.length > limit;
        if (matchesTruncated) matches.length = limit;
        const nextOffset = matchesTruncated ? Number(offset) + matches.length : undefined;
        return {
          success: true,
          data: {
            matches,
            scanned,
            offset,
            nextOffset,
            truncated: matchesTruncated || filesTruncated,
            truncationReasons: matchesTruncated ? ['limit'] : filesTruncated ? ['scanLimit'] : undefined,
            continuationHint: nextOffset !== undefined
              ? `Continue with offset=${nextOffset} and unchanged query/directory/caseSensitive; restart at 0 if files changed.`
              : filesTruncated ? 'File scan limit reached; narrow directory. Offset cannot reach unscanned files.' : undefined,
          },
        };
      },
    },
    {
      declaration: {
        name: "run_command",
        description: isZh
          ? '直接启动可执行文件并传入 args 数组，不经过 Shell，也不展开管道、重定向和环境变量。已有独立参数时优先用它，避免命令字符串转义。cwd 可指定工作区内目录；需要 Shell 语法、选择 Shell 或后台完成通知时使用 execute_command。返回的会话 ID 由 process_session 读取、输入或停止，同一账号、对话和工作区继续运行后仍可使用。'
          : 'Start an executable directly with an args array: no shell, pipe/redirection parsing or environment expansion. Prefer this for already-separated arguments to avoid shell quoting. cwd may select a directory within the workspace. Use execute_command for shell syntax, shell selection or background completion notifications. Use process_session with the returned session ID, including later runs in the same account, conversation and workspace.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string", minLength: 1 },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string", description: isZh ? '工作区内启动目录，省略时为根目录；不允许越界路径或指向工作区外的符号链接。' : 'Working directory within the workspace; defaults to its root. Outside paths or symlink targets outside the workspace are rejected.' },
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
        return {
          success: true,
          data: await processes.start(target, processOwner(context), String(args.command), args.args as string[],
            (text) => context.progress({ text }), { cwd }),
        };
      },
    },
    {
      declaration: {
        name: "process_session",
        description: isZh
          ? '读取输出、发送输入或停止同一账号、对话和工作区通过 run_command 创建的会话，继续运行后仍可使用原 id。id 必须来自 run_command，不适用于 execute_command 的后台 taskId；停止仅作用于该会话受管的进程树。read 可传 cursor/maxChars 按 UTF-16 绝对字符位置增量读取，省略时返回全部保留输出；outputOffset 为本次输出起点，nextCursor 为下次游标，hasMore 表示仍有未读输出，outputLost 表示游标早于保留区。'
          : 'Read output, send input or stop a run_command session in the same account, conversation and workspace, even after continuing in a new run. The id must come from run_command, not an execute_command background taskId. Stopping affects only the session managed process tree. For read, cursor/maxChars page by absolute UTF-16 character position; omit them to return all retained output. outputOffset is the returned output start, nextCursor is the next position, hasMore indicates unread output, and outputLost means the cursor predates the retained buffer.',
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["read", "input", "stop"] },
            id: { type: "string" },
            text: optionalText,
            cursor: { type: 'integer', minimum: 0, description: isZh ? '仅 read：上次的 nextCursor；早于保留区时返回剩余输出并标记 outputLost。' : 'Read only: previous nextCursor; an expired cursor returns retained output with outputLost.' },
            maxChars: { type: 'integer', minimum: 1, maximum: 256000, description: isZh ? '仅 read：本次最多返回的 UTF-16 字符数。' : 'Read only: maximum UTF-16 characters to return.' },
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
          return {
            success: true,
            data: await processes.read(String(args.id), owner, args.action === 'read'
              ? { cursor: args.cursor as number | undefined, maxChars: args.maxChars as number | undefined } : undefined),
          };
        } catch (error) {
          // 运行器会把普通异常统一成 TOOL_FAILED；这些可恢复状态需要保留明确错误码供模型决策。
          if (error instanceof ProcessSessionError) return { success: false, code: error.code, error: error.message };
          throw error;
        }
      },
    },
  ];
}
