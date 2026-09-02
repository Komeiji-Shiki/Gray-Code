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
    // 单条长度上限（entryChars 默认 280 字节、可调至 1000）、压缩顺序（pendingCompression → memory_compress）、
    // zoom 的二叉树节点（#a-b blockId）、forget 的三种 blockId（范围 16-31 / 单个 5 / 闭区间 1,3）。
    memory_wake: {
        description:
            'Wake up permanent memory at the start of a new work session when prior agreements may affect the task. A simple, history-independent reply that needs no tools does not require it.\n' +
            'The output has two parts: global memory and current workspace memory (isolated per workspace), marked with --- Global memory --- / --- Workspace memory ---.\n' +
            'It outputs your memory digest: recent memories are kept verbatim, older memories are compressed into summaries.\n' +
            'If the output is split into multiple parts, read them in order until you see "You are awake.". pendingCompression in a successful result may be deferred; do not interrupt the current user task.',
        parameters: {
            part: 'Part number to read (1-based). If omitted, starts from part 1.',
            snapshotT: 'Total number of memories at snapshot time. If omitted, or set to 0 on the first call, uses the current total. Used to keep consistency across multiple wake calls.'
        }
    },

    memory_note: {
        description:
            'Record a permanent memory that is likely to remain useful in future sessions.\n' +
            'The memory is saved to the current workspace\'s memory store (separate from global memory; memory_wake reads both).\n' +
            'Single line of text, limited by the entryChars cap in memory_config (default max 280 characters, counted in bytes, accented characters take 2 bytes; can be raised up to 1000 via memory_config).\n' +
            'Do not record transient progress, work logs, repository-reconstructable content, secrets, or duplicates.\n' +
            'If pendingCompression is returned, it is deferred maintenance. Do not interrupt the current user task; compress after the current deliverable.',
        parameters: {
            text: 'The memory text to record. Single line, limited by the entryChars cap in memory_config (default max 280 characters).'
        }
    },

    memory_recall: {
        description:
            'Search all permanent memories (verbatim matching). Supports regular expressions.\n' +
            'Searches both global memory and current workspace memory (isolated per workspace); hits are labeled with --- Global memory --- / --- Workspace memory ---.\n' +
            'The search also covers raw memories that were compressed into summaries — compression does not lose information.\n' +
            'Results are limited to a single output capacity; if truncated, it will suggest narrowing the regex.',
        parameters: {
            regex: 'Search regular expression (case-insensitive). The search covers IDs and dates.'
        }
    },

    memory_compress: {
        description:
            'Run pending memory compression merges.\n' +
            'The memory system uses a binary tree structure: adjacent memories are merged pairwise into one-line summaries, and summaries are merged further.\n' +
            'pendingCompression from a successful memory_note or memory_wake is deferred maintenance and must not interrupt the current user task. It is immediately required only when memory_wake fails because a summary is missing.\n' +
            'Once maintenance starts, follow prompts in order. Independent scopes may be handled with calls in the same response.\n' +
            'Parameters: blockId (block ID, e.g. "0-1"); summary (compressed summary text, one line, limited by the entryChars cap, default ≤280 bytes).\n' +
            'With no arguments, returns the next pending compression prompt.\n' +
            'Scope: with a workspace open, defaults to the current workspace memory; pass scope="global" to operate on global memory.',
        parameters: {
            blockId: 'Block ID to compress (e.g. "0-1"). Copy it from the compression prompt.',
            summary: 'The compressed summary text. One line, limited by the entryChars cap (default max 280 bytes). Preserve durable decisions, preferences, constraints, facts, and necessary context; drop transient progress and repetition. Do not fabricate.',
            scope: 'Memory scope. With a workspace open, defaults to the current workspace memory; pass "global" to operate on global memory, or "workspace" to explicitly operate on workspace memory.'
        }
    },

    memory_zoom: {
        description:
            'Expand a memory tree node to see its two halves.\n' +
            'Memories form a binary tree: every line "#a-b" in the memory_wake output is a node.\n' +
            'Use memory_zoom to expand it and see the two halves at the next level, all the way down to the raw memories.\n' +
            'Parameters: blockId (block ID, e.g. "16-31").\n' +
            'Scope: with a workspace open, defaults to reading the current workspace memory; pass scope="global" to read global memory.',
        parameters: {
            blockId: 'Block ID to expand (e.g. "16-31"). Copy it from the wake output or the previous zoom result.',
            scope: 'Memory scope. With a workspace open, defaults to reading the current workspace memory; pass "global" to read global memory, or "workspace" to explicitly read workspace memory.'
        }
    },

    memory_forget: {
        description:
            'Discard wrong tree summaries, or delete raw memories.\n' +
            'When blockId is a range (e.g. "16-31", dash-separated): only discards the tree summary and its ancestor summaries; raw memories (LOG) are not touched.\n' +
            'When blockId is a single number (e.g. "5"): deletes that one raw memory (later record ids are shifted and renumbered).\n' +
            'When blockId is a closed interval (e.g. "1,3", comma-separated): deletes all raw memories with IDs 1 through 3 (inclusive).\n' +
            'Parameters: blockId (block ID like "16-31", single ID like "5", or closed interval like "1,3").\n' +
            'Scope: with a workspace open, defaults to the current workspace memory; pass scope="global" to operate on global memory.',
        parameters: {
            blockId: 'Block ID (e.g. "16-31") discards tree summaries; single ID (e.g. "5") deletes that one memory; closed interval (e.g. "1,3") deletes all memories 1 through 3.',
            scope: 'Memory scope. With a workspace open, defaults to the current workspace memory; pass "global" to operate on global memory, or "workspace" to explicitly operate on workspace memory.'
        }
    },

    memory_config: {
        description:
            'View or modify configuration parameters of the permanent memory system.\n' +
            'Configurable items:\n' +
            '- wakeLines: line budget for wake output (default 96, ≈8k tokens)\n' +
            '- entryChars: max bytes per memory entry (default 280, max 1000)\n' +
            '- partChars: max characters per output part (default 20000)\n' +
            '- partLines: max lines per output part (default 500)\n' +
            'With no arguments, shows the current config. With arguments, updates the corresponding items.\n' +
            'Changes only affect output formatting; nothing needs to be recomputed.',
        parameters: {
            wakeLines: 'Line budget for wake output. Larger values = more detail.',
            entryChars: 'Max bytes per memory entry. Default 280, max 1000 (fixed-width record constraint, including record header overhead).',
            partChars: 'Max characters per output part.',
            partLines: 'Max lines per output part.'
        }
    }
};
