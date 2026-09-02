/**
 * GrayCode - 中文工具说明：记忆 / 活动统计 / 通知
 *
 * 覆盖工具：
 * - memory_wake / memory_note / memory_recall / memory_compress / memory_zoom /
 *   memory_forget / memory_config
 * - get_activity_stats
 * - show_windows_notification
 *
 * 注意：
 * - memory_* 说明必须保留全局/工作区作用域、分页快照、字节上限和压缩顺序语义；
 * - memory_note 的单条长度上限（entryChars，默认 280 字节）语义要保留。
 */

import type { ToolDescriptionLocalization } from '../../types';

export const auxiliary: Record<string, ToolDescriptionLocalization> = {
    memory_wake: {
        description:
            '唤醒永久记忆。在新的工作会话开始、且历史约定可能影响任务时调用；简单且与历史无关的无工具回复无需调用。\n' +
            '输出包含两部分：全局记忆与当前工作区记忆（按工作区隔离），以 --- Global memory --- / --- Workspace memory --- 标注。\n' +
            '它会输出你的记忆摘要：近期的记忆保持原文，远期的记忆被压缩为摘要。\n' +
            '如果输出被分成多个部分，按顺序读取直到看到 "You are awake." 为止。成功结果中的 pendingCompression 可延后，不要中断当前用户任务。',
        parameters: {
            part: '要读取的部分号（1-based）。不传则从第 1 部分开始。',
            snapshotT: '快照时的记忆总数。不传或首次调用传 0 时使用当前总数。用于跨多次 wake 调用保持一致性。'
        }
    },

    memory_note: {
        description:
            '记录一条对未来会话仍有价值的永久记忆。\n' +
            '记忆保存到当前工作区的记忆存储（与全局记忆分开，memory_wake 会同时读取两者）。\n' +
            '一行文本，长度受 memory_config 的 entryChars 上限控制（默认最多 280 字符，按字节计，重音字符占 2 字节；可经 memory_config 调高至 1000）。\n' +
            '不要记录临时进度、工作日志、可从仓库重建的内容、秘密或重复信息。\n' +
            '如果返回 pendingCompression，它只是可延后的维护提示；不要中断当前用户任务，完成当前交付后再压缩。',
        parameters: {
            text: '要记录的记忆文本。一行，长度受 memory_config 的 entryChars 上限控制（默认最多 280 字符）。'
        }
    },

    memory_recall: {
        description:
            '搜索全部永久记忆（逐字匹配）。支持正则表达式。\n' +
            '搜索范围包括全局记忆与当前工作区记忆（按工作区隔离），命中结果以 --- Global memory --- / --- Workspace memory --- 标注来源。\n' +
            '搜索范围包括已被压缩摘要的原始记忆——压缩不会丢失信息。\n' +
            '结果限制在单次输出容量内，如果被截断会提示缩小正则范围。',
        parameters: {
            regex: '搜索正则表达式（大小写不敏感）。搜索范围包括 ID 和日期。'
        }
    },

    memory_compress: {
        description:
            '执行待处理的记忆压缩合并。\n' +
            '记忆系统使用二叉树结构：相邻记忆两两合并为一行摘要，摘要再合并。\n' +
            '成功的 memory_note 或 memory_wake 返回的 pendingCompression 是可延后的维护提示，不要因此中断当前用户任务；memory_wake 因缺少摘要失败时才必须立即处理。\n' +
            '开始维护后按提示顺序执行；不同作用域的独立压缩可以在同一响应中调用。\n' +
            '参数：blockId（块 ID，如 "0-1"）；summary（压缩后的摘要文本，一行，长度受 entryChars 上限约束，默认 ≤280 字节）。\n' +
            '不传参数时，返回下一个待压缩的提示。\n' +
            '作用域：有工作区时默认作用于当前工作区记忆；如需操作全局记忆请传 scope="global"。',
        parameters: {
            blockId: '要压缩的块 ID（如 "0-1"）。从压缩提示中复制。',
            summary: '压缩后的摘要文本。一行，长度受 entryChars 上限约束（默认最多 280 字节）。保留持久的决定、偏好、约束、事实及必要上下文，丢弃临时进度和重复。不要编造。',
            scope: '记忆作用域。有工作区时默认作用于当前工作区记忆；如需操作全局记忆请传 "global"，如需显式操作工作区记忆请传 "workspace"。'
        }
    },

    memory_zoom: {
        description:
            '展开一个记忆树节点，查看它的两个半部分。\n' +
            '记忆形成一棵二叉树：memory_wake 输出的每一行 #a-b 都是一个节点。\n' +
            '用 memory_zoom 可以展开它，看到下一层的两个半部分，直到原始记忆本身。',
        parameters: {
            blockId: '要展开的块 ID（如 "16-31"）。从 wake 输出或上一次 zoom 的结果中复制。',
            scope: '记忆作用域。有工作区时默认读取当前工作区记忆；如需读取全局记忆请传 "global"，如需显式读取工作区记忆请传 "workspace"。'
        }
    },

    memory_forget: {
        description:
            '丢弃错误的树摘要，或删除原始记忆。\n' +
            '当 blockId 是范围（如 "16-31"，破折号）：仅丢弃树摘要及其上层摘要，原始记忆（LOG）不会被触碰。\n' +
            '当 blockId 是单个数字（如 "5"）：删除这一条原始记忆（其后的记录 id 前移重编号）。\n' +
            '当 blockId 是闭区间（如 "1,3"，逗号分隔）：删除 ID 1 到 3 的所有原始记忆（含端点）。',
        parameters: {
            blockId: '块 ID（如 "16-31"）丢弃树摘要；单个 ID（如 "5"）删除这一条记忆；闭区间（如 "1,3"）删除 1 到 3 的所有记忆。',
            scope: '记忆作用域。有工作区时默认作用于当前工作区记忆；如需操作全局记忆请传 "global"，如需显式操作工作区记忆请传 "workspace"。'
        }
    },

    memory_config: {
        description:
            '查看或修改永久记忆系统的配置参数。\n' +
            '可配置项：\n' +
            '- wakeLines: wake 输出的行数预算（默认 96，≈8k tokens）\n' +
            '- entryChars: 单条记忆最大字节数（默认 280，上限 1000）\n' +
            '- partChars: 输出分页最大字符数（默认 20000）\n' +
            '- partLines: 输出分页最大行数（默认 500）\n' +
            '不传参数时显示当前配置。传参数时修改对应项。\n' +
            '修改只影响输出格式，不需要重新计算任何东西。',
        parameters: {
            wakeLines: 'wake 输出的行数预算。更大的值 = 更多细节。',
            entryChars: '单条记忆最大字节数。默认 280，上限 1000（固定宽度记录约束，含记录头部开销）。',
            partChars: '输出分页最大字符数。',
            partLines: '输出分页最大行数。'
        }
    },

    get_activity_stats: {
        description:
            '获取用户的 IDE 使用时间统计：每日使用时长（分钟）、最近作息（用户活跃时段的小时热力图，可选用）、当前连续工作时长。' +
            '用于了解用户的工作-休息节奏、发现长时间连续工作会话，或判断用户当前是否活跃。' +
            '数据只包含时间戳，不含任何用户内容。返回时间均为本地时间（HH:mm、YYYY-MM-DD）。',
        parameters: {
            range: '统计范围：today / 7d（最近 7 天）/ 30d / 90d / 365d / all（全部历史）。默认：7d。',
            includeHourly: '是否包含小时热力图（每天 24 个时段、每小时活跃分钟数，本地时间）。有助于分析用户的作息规律。默认：false。',
            includeMonthly: '是否包含月度聚合（总分钟数、活跃天数、每月会话数）。有助于长期使用概览。默认：false。'
        }
    },

    show_windows_notification: {
        description:
            '显示带有自定义标题和消息的 Windows 系统通知。' +
            '当需要在聊天界面之外通知用户时使用，例如长任务完成、需要用户操作或重要状态变化时。' +
            '在非 Windows 平台上，本工具会报告通知不受支持。',
        parameters: {
            title: '通知标题。保持简短清晰。',
            message: '通知正文。为用户概括重要信息。',
            silent: '是否抑制通知声音。默认：true。',
            openChatOnClick: '点击通知时是否打开 GrayCode 聊天视图。默认：true。'
        }
    }
};
