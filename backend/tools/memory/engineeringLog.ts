import type { Tool, ToolDeclaration } from '../types';
import type { MemoryToolHost } from './host';
import { MAX_ENTRY_CHARS, MAX_TREE_SUMMARY_BYTES } from '../../modules/memory/logFormat';
import type { EngineeringLogAction } from '../../modules/memory/types';
import { createMemoryWakeRuntime } from './memory_wakeRuntime';
import { createMemoryNoteRuntime } from './memory_noteRuntime';
import { createMemoryRecallRuntime } from './memory_recallRuntime';
import { createMemoryCompressRuntime } from './memory_compressRuntime';
import { createMemoryZoomRuntime } from './memory_zoomRuntime';
import { createMemoryForgetRuntime } from './memory_forgetRuntime';
import { createMemoryConfigRuntime } from './memory_configRuntime';

export { ENGINEERING_LOG_LEGACY_NAMES, type EngineeringLogAction } from '../../modules/memory/types';

const actionTools = {
    wake: (host: MemoryToolHost) => createMemoryWakeRuntime(host).createMemoryWakeTool(),
    note: (host: MemoryToolHost) => createMemoryNoteRuntime(host).createMemoryNoteTool(),
    recall: (host: MemoryToolHost) => createMemoryRecallRuntime(host).createMemoryRecallTool(),
    compress: (host: MemoryToolHost) => createMemoryCompressRuntime(host).createMemoryCompressTool(),
    zoom: (host: MemoryToolHost) => createMemoryZoomRuntime(host).createMemoryZoomTool(),
    forget: (host: MemoryToolHost) => createMemoryForgetRuntime(host).createMemoryForgetTool(),
    config: (host: MemoryToolHost) => createMemoryConfigRuntime(host).createMemoryConfigTool(),
} satisfies Record<EngineeringLogAction, (host: MemoryToolHost) => Tool>;

export function engineeringLogMutation(args: Record<string, unknown>): boolean {
    return args.action === 'note' || args.action === 'forget'
        || args.action === 'compress' && args.summary !== undefined
        || args.action === 'config' && ['wakeLines', 'entryChars', 'partChars', 'partLines'].some(key => Object.hasOwn(args, key));
}

export function createEngineeringLogDeclaration(): ToolDeclaration {
    return {
        name: 'engineering_log',
        description:
            '管理工程日志中的项目约定与技术经验；用户事实、偏好和经历使用个人长期记忆的 memory_search / memory_remember。' +
            'wake/recall 同时读取全局与当前工作区，note 写入当前工作区（无工作区时写全局）。' +
            '只记录以后仍有用且难以从仓库重建的信息，不保存临时进度、秘密或重复内容。' +
            '成功结果中的 pendingCompression 可延后至当前交付完成；仅 wake 因缺少摘要失败时先压缩再重试。' +
            '不同作用域的独立压缩可以同时调用。config 调整账号共享格式，不改写已保存的记忆。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['wake', 'note', 'recall', 'compress', 'zoom', 'forget', 'config'],
                    description: 'wake 读概览；note 记录；recall 正则搜索；compress 摘要维护；zoom 展开树节点；forget 删除；config 查看或更新格式。',
                },
                text: {
                    type: 'string',
                    description: `note 必填，单行；UTF-8 字节数受 entryChars 限制（默认 280，最大 ${MAX_ENTRY_CHARS}）。`,
                },
                regex: {
                    type: 'string',
                    description: 'recall 必填，不区分大小写，搜索原文、ID 和日期；截断时缩小范围。',
                },
                blockId: {
                    type: 'string',
                    description: 'zoom/forget 必填；compress 提交时从提示复制。forget 用 a-b 丢弃摘要，用单个 ID 或闭区间 a,b 删除原文。',
                },
                summary: {
                    type: 'string',
                    description: `compress 与 blockId 一起提交单行摘要，限 min(entryChars, ${MAX_TREE_SUMMARY_BYTES}) 字节；都省略时取待办。`,
                },
                scope: {
                    type: 'string',
                    enum: ['global', 'workspace'],
                    description: '仅 zoom/compress/forget 使用；默认当前工作区，无工作区时为全局。',
                },
                part: {
                    type: 'integer',
                    minimum: 1,
                    description: 'wake 页码，默认 1；按提示续读至 You are awake.。',
                },
                snapshotT: {
                    type: 'integer',
                    minimum: 0,
                    description: 'wake 续读时复制返回的快照总数；首次省略或为 0。',
                },
                wakeLines: { type: 'number', description: 'config：概览行数预算，默认 96。' },
                entryChars: { type: 'number', description: `config：单条字节上限，默认 280，最大 ${MAX_ENTRY_CHARS}。` },
                partChars: { type: 'number', description: 'config：每页字符上限，默认 20000。' },
                partLines: { type: 'number', description: 'config：每页行数上限，默认 500。' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    };
}

/** 执行仍按各操作的原始 schema 校验，模型侧不重复发送整套字段。 */
export function engineeringLogValidationSchema(host: MemoryToolHost) {
    return {
        // 根字段也供严格协议的可选 null 归一化使用，分支只补各操作自己的约束。
        ...createEngineeringLogDeclaration().parameters,
        oneOf: Object.entries(actionTools).map(([action, create]) => {
            const parameters = create(host).declaration.parameters;
            return {
                ...parameters,
                properties: { action: { type: 'string', const: action }, ...parameters.properties },
                required: ['action', ...(parameters.required ?? [])],
                additionalProperties: false,
            };
        }),
    };
}

export function createEngineeringLogTool(host: MemoryToolHost): Tool {
    return {
        declaration: createEngineeringLogDeclaration(),
        handler: (args, context) => {
            const { action, ...parameters } = args;
            return actionTools[action as EngineeringLogAction](host).handler(parameters, context);
        },
    };
}
