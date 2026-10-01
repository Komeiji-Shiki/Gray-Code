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
 * - memory_note 的单条长度上限（entryChars，默认 280 字节，上限 MAX_ENTRY_CHARS）语义要保留；
 * - 区分「工程日志记忆」（memory_note 等本组工具）与「个人长期记忆」（memory_search / memory_remember 等）。
 */

import type { ToolDescriptionLocalization } from '../../types';
import { MAX_ENTRY_CHARS, MAX_TREE_SUMMARY_BYTES } from '../../../../modules/memory/logFormat';

export const auxiliary: Record<string, ToolDescriptionLocalization> = {
    memory_wake: {
        description:
            '读取工程日志记忆，也就是 memory_note 写下的项目约定和经验。它和用户的个人长期记忆是两套系统，个人长期记忆请用 memory_search 或 memory_read 查阅。\n' +
            '在新的工作会话开始、且以往的约定可能影响当前任务时调用；与历史无关、也不需要工具的简单回复不必调用。\n' +
            '输出分为全局记忆和当前工作区记忆两部分，分别以 --- Global memory --- 和 --- Workspace memory --- 标注。近期的记忆保留原文，较早的记忆以压缩摘要呈现。\n' +
            '输出较长时会分成多个部分，请按输出末尾的提示依次读取，直到看到 "You are awake." 为止。成功结果中的 pendingCompression 可延后处理，不要中断当前用户任务。',
        parameters: {
            part: '要读取的部分号，从 1 开始，默认为 1。',
            snapshotT: '第一次读取时的记忆总数，从输出末尾的提示中复制，用来让后续部分与第一部分保持一致。首次调用不传或传 0，表示使用当前总数。'
        }
    },

    memory_note: {
        description:
            '记录一条在以后的会话里仍然有用的工程日志，例如项目约定、踩过的坑或长期的技术决定。用户本人的事实、偏好和经历属于个人长期记忆，请用 memory_remember 记录，不要用本工具代替。\n' +
            '有工作区时，记录保存到当前工作区的记忆中，与全局记忆分开；memory_wake 会同时读取两者。\n' +
            '不要记录临时进度、工作流水、可以从仓库重新得到的内容、秘密或重复的信息。\n' +
            '如果结果包含 pendingCompression，它只是可延后的维护提示：不要中断当前用户任务，完成当前交付后再压缩；同一个待压缩状态不会重复提示。',
        parameters: {
            text: `要记录的文本，只能有一行。长度按 UTF-8 字节计算，上限是 memory_config 的 entryChars（默认 280 字节，一个中文字符通常占 3 字节），最高可调到 ${MAX_ENTRY_CHARS}。`
        }
    },

    memory_recall: {
        description:
            '用正则表达式逐字搜索工程日志记忆，也就是 memory_note 写下的项目约定和经验。用户的个人长期记忆不在这里，请用 memory_search。\n' +
            '搜索同时覆盖全局记忆和当前工作区记忆，命中结果以 --- Global memory --- 和 --- Workspace memory --- 标注来源。已被压缩成摘要的原始记忆也在搜索范围内，压缩不会丢失信息。\n' +
            '结果受单次输出容量限制；被截断时会提示你缩小正则范围。',
        parameters: {
            regex: '搜索用的正则表达式，不区分大小写，也会匹配记忆的 ID 和日期。'
        }
    },

    memory_compress: {
        description:
            '处理待压缩的工程日志记忆。记忆按二叉树组织：相邻的两条记忆合并成一行摘要，摘要再两两合并。\n' +
            '不传 blockId 和 summary 时，返回下一个待压缩的提示；按提示写好摘要后，再用 blockId 和 summary 提交。\n' +
            '成功的 memory_note 或 memory_wake 返回的 pendingCompression 是可延后的维护提示，不要因此中断当前用户任务；memory_wake 因缺少摘要失败时才必须立即处理。\n' +
            '开始维护后按提示顺序执行；不同作用域的独立压缩可以在同一响应中调用。',
        parameters: {
            blockId: '要压缩的块 ID，例如 "0-1"，从压缩提示中复制。',
            summary: `压缩后的摘要，只能有一行。长度不能超过 entryChars 和 ${MAX_TREE_SUMMARY_BYTES} 字节中较小的那个，默认配置下最多 280 字节。保留长期有效的决定、偏好、约束、事实和必要的上下文，去掉临时进度和重复内容，不要编造。`,
            scope: '记忆作用域。有工作区时默认操作当前工作区记忆；传 "global" 操作全局记忆，传 "workspace" 显式操作工作区记忆。'
        }
    },

    memory_zoom: {
        description:
            '展开工程日志记忆树中的一个节点，查看它下一层的两个半部分。\n' +
            'memory_wake 输出中每一行 #a-b 都是一个节点。逐层展开，最终可以看到原始记忆本身。',
        parameters: {
            blockId: '要展开的块 ID，例如 "16-31"，从 memory_wake 的输出或上一次 memory_zoom 的结果中复制。',
            scope: '记忆作用域。有工作区时默认读取当前工作区记忆；传 "global" 读取全局记忆，传 "workspace" 显式读取工作区记忆。'
        }
    },

    memory_forget: {
        description:
            '丢弃有误的工程日志树摘要，或删除原始记忆。具体行为取决于 blockId 的写法：\n' +
            '- 用短横线表示的块，例如 "16-31"：只丢弃这个摘要及其上层摘要，原始记忆保持不变。\n' +
            '- 单个数字，例如 "5"：删除这一条原始记忆，之后的记忆 ID 依次前移。\n' +
            '- 用逗号表示的闭区间，例如 "1,3"：删除 ID 1 到 3（含两端）的所有原始记忆。',
        parameters: {
            blockId: '要处理的块 ID（如 "16-31"）、单个记忆 ID（如 "5"）或闭区间（如 "1,3"）。',
            scope: '记忆作用域。有工作区时默认操作当前工作区记忆；传 "global" 操作全局记忆，传 "workspace" 显式操作工作区记忆。'
        }
    },

    memory_config: {
        description:
            '查看或修改工程日志记忆的配置。不传参数时返回当前配置；传入参数时只修改对应的项。\n' +
            '这些配置控制 memory_wake 的输出篇幅、分页方式和以后写入的单条长度上限，修改后不会改写已保存的记忆。',
        parameters: {
            wakeLines: 'memory_wake 输出的行数预算，默认 96（约 8k tokens）。值越大，保留的细节越多。',
            entryChars: `单条记忆的最大字节数，默认 280，最高 ${MAX_ENTRY_CHARS}。`,
            partChars: '每个输出部分的最大字符数，默认 20000。',
            partLines: '每个输出部分的最大行数，默认 500。'
        }
    },

    get_activity_stats: {
        description:
            '获取用户的 IDE 使用时间统计：每日使用时长（分钟）、最近作息（用户活跃时段的小时热力图，可选用）、当前连续工作时长。' +
            '用于了解用户的工作与休息节奏、发现长时间连续工作，或判断用户当前是否活跃。' +
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
