/**
 * GrayCode - 英文工具说明覆盖
 *
 * 英文语言下默认使用工具原始英文声明；本文件只覆盖：
 * - 原文错误（如 delete_code 参数说明中 parameterMUST 的拼写）；
 * - 需要统一风格或补充高价值语义的工具。
 *
 * 注意：动态工具（read_file、图片工具、execute_command、history_search、read_skill、
 * subagents、agent_send_message）不配置 description，顶层说明由语言感知生成器负责。
 */

import type { ToolDescriptionLocalization } from '../../types';
import { MAX_ENTRY_CHARS, MAX_TREE_SUMMARY_BYTES } from '../../../../modules/memory/logFormat';

export const overrides: Record<string, ToolDescriptionLocalization> = {
    // delete_code 的 "parameterMUST" 拼写错误位于其顶层 description
    // （"The `files` parameterMUST be an array..."）。该顶层说明会随多根工作区动态拼接
    // 工作区名单，不能整体覆盖；因此在这里提供修正后的 files 参数说明，
    // 让模型在参数层看到正确的 "MUST be an array" 语义与示例。
    delete_code: {
        parameters: {
            files: 'Array of delete operations. Each element specifies a file and line range to delete. MUST be an array even for a single file. Example: `{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`.'
        }
    },

    // memory_* 工具的源声明为中文，这里提供与源声明及 zh-CN/auxiliary.ts 语义对等的英文覆盖。
    // 必须保留：全局/工作区作用域（scope: global|workspace）、分页快照（part 1-based、snapshotT）、
    // 单条长度上限（entryChars 默认 280 字节、上限 MAX_ENTRY_CHARS）、压缩顺序（pendingCompression → memory_compress）、
    // zoom 的二叉树节点（#a-b blockId）、forget 的三种 blockId（范围 16-31 / 单个 5 / 闭区间 1,3），
    // 以及「工程日志记忆」与「个人长期记忆（memory_search / memory_remember）」的区分。
    memory_wake: {
        description:
            'Read the engineering log memory: the project conventions and lessons written with memory_note. This is separate from the user\'s personal long-term memory, which you look up with memory_search or memory_read.\n' +
            'Call it at the start of a new work session when earlier agreements may affect the task. A simple reply that does not depend on history and needs no tools does not require it.\n' +
            'The output has a global memory part and a current workspace part, marked --- Global memory --- and --- Workspace memory ---. Recent memories appear verbatim; older ones appear as compressed summaries.\n' +
            'Long output is split into parts. Follow the hint at the end of each part and keep reading until you see "You are awake.". A pendingCompression in a successful result can wait; do not interrupt the current user task for it.',
        parameters: {
            part: 'Part number to read, starting at 1. Defaults to 1.',
            snapshotT: 'Total number of memories at the first read, copied from the hint at the end of the output, so that later parts stay consistent with the first. Omit it, or pass 0, on the first call to use the current total.'
        }
    },

    memory_note: {
        description:
            'Record an engineering log entry that will still be useful in later sessions, such as a project convention, a lesson learned or a lasting technical decision. The user\'s own facts, preferences and experiences belong to personal long-term memory; record those with memory_remember, not with this tool.\n' +
            'With a workspace open, the entry is saved to that workspace\'s memory, separate from global memory; memory_wake reads both.\n' +
            'Do not record transient progress, work logs, anything that can be recovered from the repository, secrets or duplicates.\n' +
            'A pendingCompression in the result is deferred maintenance: do not interrupt the current user task, and compress after the current deliverable. The same pending state is not reported again.',
        parameters: {
            text: `The text to record, on a single line. Length is measured in UTF-8 bytes and is capped by entryChars in memory_config (280 bytes by default; non-ASCII characters take 2 to 4 bytes each), which can be raised up to ${MAX_ENTRY_CHARS}.`
        }
    },

    memory_recall: {
        description:
            'Search the engineering log memory, the project conventions and lessons written with memory_note, using a regular expression that matches the stored text verbatim. The user\'s personal long-term memory is not here; use memory_search for it.\n' +
            'The search covers both global memory and current workspace memory, and hits are labeled --- Global memory --- or --- Workspace memory ---. Raw memories that have been compressed into summaries are searched too, so compression does not lose information.\n' +
            'Results are limited to one output\'s capacity; when they are truncated, the output suggests narrowing the regex.',
        parameters: {
            regex: 'Case-insensitive regular expression to search for. It also matches memory IDs and dates.'
        }
    },

    memory_compress: {
        description:
            'Handle pending compression of the engineering log memory. Memories form a binary tree: two adjacent memories are merged into a one-line summary, and summaries are merged in pairs again.\n' +
            'Called without blockId and summary, it returns the next compression prompt; write the summary as the prompt asks, then submit it with blockId and summary.\n' +
            'A pendingCompression returned by a successful memory_note or memory_wake is deferred maintenance and should not interrupt the current user task. It must be handled right away only when memory_wake fails because a summary is missing.\n' +
            'Once maintenance starts, follow the prompts in order. Independent compressions in different scopes can be called in the same response.',
        parameters: {
            blockId: 'Block ID to compress, such as "0-1", copied from the compression prompt.',
            summary: `The compressed summary, on a single line. It may not exceed the smaller of entryChars and ${MAX_TREE_SUMMARY_BYTES} bytes, which is 280 bytes under the default config. Keep durable decisions, preferences, constraints, facts and necessary context, drop transient progress and repetition, and do not make anything up.`,
            scope: 'Memory scope. With a workspace open, the current workspace memory is used by default; pass "global" for global memory, or "workspace" to select workspace memory explicitly.'
        }
    },

    memory_zoom: {
        description:
            'Expand one node of the engineering log memory tree to see its two halves at the next level.\n' +
            'Every line "#a-b" in the memory_wake output is a node. Expanding level by level eventually shows the raw memories themselves.',
        parameters: {
            blockId: 'Block ID to expand, such as "16-31", copied from the memory_wake output or the previous memory_zoom result.',
            scope: 'Memory scope. With a workspace open, the current workspace memory is read by default; pass "global" to read global memory, or "workspace" to select workspace memory explicitly.'
        }
    },

    memory_forget: {
        description:
            'Discard a wrong summary in the engineering log memory tree, or delete raw memories. What happens depends on the form of blockId:\n' +
            '- A block with a dash, such as "16-31": only that summary and the summaries above it are discarded; raw memories stay unchanged.\n' +
            '- A single number, such as "5": that one raw memory is deleted, and later memory IDs shift down.\n' +
            '- A closed interval with a comma, such as "1,3": all raw memories with IDs 1 through 3, inclusive, are deleted.',
        parameters: {
            blockId: 'The block ID (such as "16-31"), single memory ID (such as "5") or closed interval (such as "1,3") to act on.',
            scope: 'Memory scope. With a workspace open, the current workspace memory is used by default; pass "global" for global memory, or "workspace" to select workspace memory explicitly.'
        }
    },

    memory_config: {
        description:
            'View or change the settings of the engineering log memory. Called without arguments, it returns the current settings; with arguments, it changes only those items.\n' +
            'The settings control how much memory_wake outputs, how output is split into parts and how long new entries may be. Changing them does not rewrite memories that are already saved.',
        parameters: {
            wakeLines: 'Line budget for memory_wake output, 96 by default (about 8k tokens). Larger values keep more detail.',
            entryChars: `Maximum size of a single memory in bytes, 280 by default and at most ${MAX_ENTRY_CHARS}.`,
            partChars: 'Maximum number of characters in each output part, 20000 by default.',
            partLines: 'Maximum number of lines in each output part, 500 by default.'
        }
    }
};
