import type { RuntimeTool, ToolContext } from "@graycode/core";
import { WorkspaceFiles } from "./files";
import { WorkspaceProcesses, commandEffects } from "./processes";
import type { WorkspaceChanges } from './changes';

function workspace(context: ToolContext) {
  if (!context.workspace)
    throw new Error("Select a workspace before using local tools.");
  return context.workspace;
}
const optionalText = { type: "string" };
export function workspaceTools(
  files: WorkspaceFiles,
  processes: WorkspaceProcesses,
  changes: WorkspaceChanges,
): RuntimeTool[] {
  return [
    {
      declaration: {
        name: "workspace_files",
        description:
          "List, read, write, edit or delete a workspace text file. Read returns its hash; writing requires expectedHash (null for a new file). Edit replaces exactly one oldText occurrence. Unsaved editor drafts and external modifications produce conflicts.",
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
          const lines = value.text.split("\n");
          const start = Math.max(0, Number(args.startLine ?? 1) - 1);
          const end = Math.min(
            lines.length,
            Number(args.endLine ?? start + 300),
            start + 1200,
          );
          return {
            success: true,
            data: {
              hash: value.hash,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
              content: lines.slice(start, end).join("\n"),
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
        description:
          "Search literal text in workspace UTF-8 files. Skips symlinks, .git, node_modules and binary/large files. Returns bounded matching lines.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            directory: optionalText,
            caseSensitive: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["query"],
        },
      },
      effects: () => ["workspace_read"],
      execute: async (args, context) => {
        const target = workspace(context);
        const pending = [String(args.directory ?? ".")];
        const matches: { path: string; line: number; text: string }[] = [];
        const limit = Number(args.limit ?? 100);
        const query = args.caseSensitive
          ? String(args.query)
          : String(args.query).toLowerCase();
        let scanned = 0;
        while (pending.length && matches.length < limit && scanned < 20_000) {
          context.signal.throwIfAborted();
          for (const entry of await files.list(target, pending.pop()!)) {
            if (entry.kind === "directory") {
              if (![".git", "node_modules"].includes(entry.name))
                pending.push(entry.path);
              continue;
            }
            if (entry.kind !== "file") continue;
            scanned++;
            let text: string;
            try {
              text = (await files.read(target, entry.path)).text;
            } catch {
              continue;
            }
            for (const [line, value] of text.split("\n").entries()) {
              if (
                (args.caseSensitive ? value : value.toLowerCase()).includes(
                  query,
                )
              )
                matches.push({
                  path: entry.path,
                  line: line + 1,
                  text: value.slice(0, 1200),
                });
              if (matches.length >= limit) break;
            }
            if (matches.length >= limit || scanned >= 20_000) break;
          }
        }
        return {
          success: true,
          data: {
            matches,
            scanned,
            truncated: matches.length >= limit || scanned >= 20_000,
          },
        };
      },
    },
    {
      declaration: {
        name: "run_command",
        description:
          "Start an executable with an argument array in the selected workspace. No implicit shell. Use an explicit shell executable for shell syntax. Configured approval rules apply, with deletion and identified high-risk operations classified separately. Returns a session ID for ongoing work.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string", minLength: 1 },
            args: { type: "array", items: { type: "string" } },
          },
          required: ["command", "args"],
        },
      },
      effects: commandEffects,
      execute: async (args, context) => ({
        success: true,
        data: await processes.start(
          workspace(context),
          context.runId,
          String(args.command),
          args.args as string[],
          (text) => context.progress({ text }),
        ),
      }),
    },
    {
      declaration: {
        name: "process_session",
        description:
          "Read output, send input, or stop a process session created by this task. Stopping affects its managed process tree only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["read", "input", "stop"] },
            id: { type: "string" },
            text: optionalText,
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
        if (args.action === "input") {
          if (typeof args.text !== "string")
            throw new Error("Supply process input.");
          processes.input(String(args.id), context.runId, args.text);
        }
        if (args.action === "stop")
          await processes.stop(String(args.id), context.runId);
        return {
          success: true,
          data: await processes.read(String(args.id), context.runId),
        };
      },
    },
  ];
}
