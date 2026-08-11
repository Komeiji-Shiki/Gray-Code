/**
 * GrayCode - 工具执行服务：mailbox 收件箱排水（mailbox drain epoch / inbox 注入）
 *
 * ToolExecutionService.ts 职责拆分（第二批）的 MailboxCore 基类。
 * 继承链：ToolExecutionService → ExecutionCore → ResultCore → PreflightCore → MailboxCore。
 *
 * 本文件承载：
 * - MED-1：drain epoch 领取 / 所有权检查 / 释放（claimMailboxDrainEpoch / isMailboxDrainOwner / releaseMailboxDrainEpoch）
 * - E-2：会话级 epoch 清理（clearMailboxDrainEpochsForConversation）
 * - A-COMM：inbox 排水与注入（injectInboxMessages / drainInboxIntoResults）
 *
 * 逻辑与拆分前逐字一致；仅可见性从 private 调整为 protected（跨继承类调用所需，
 * 编译期属性，零运行时影响）。
 */
import { agentMailbox } from '../../../../../core/services/agentMailbox';
import type { ContentPart } from '../../../../conversation/types';
import type { ToolExecutionResult } from '../../utils';

/**
 * mailbox 收件箱排水基类（drain epoch 收敛 + inbox 注入）
 */
export class MailboxCore {
    /**
     * MED-1：同一 (conversationId, runId) 下并发执行循环的 drain 权收敛。
     *
     * 主会话工具循环存在两个并发生成器：流式边执行早启动路径（executeFunctionCallsWithResults，
     * 流式期间启动）与流式结束后的主循环（executeFunctionCallsWithProgress），两者共享 mailbox
     * 身份 (conversationId, MAIN_SESSION_RUN_ID) 并各自调用 injectInboxMessages。drain 本身同步
     * 互斥，但消息挂在哪个结果上取决于调度顺序——abort 丢弃路径会让消息随被丢弃的结果一起丢失。
     *
     * 收敛规则：每个执行循环启动时领取自增 epoch（key = conversationId + runId）；
     * injectInboxMessages 只允许「最新启动」的循环 drain（它就是最终落盘的执行循环）。
     * 早启动路径在主循环启动后自动失去 drain 权（只执行不 drain），消息统一挂在主循环结果上；
     * 主循环不存在时（全部工具已早启动），早启动路径即最终落盘循环，仍正常 drain。
     */
    protected readonly mailboxDrainEpochs = new Map<string, number>();
    protected mailboxDrainEpochCounter = 0;

    protected claimMailboxDrainEpoch(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined
    ): { key: string; epoch: number } | undefined {
        if (!mailboxConversationId || !mailboxRunId) {
            return undefined;
        }
        const key = `${mailboxConversationId}\u0000${mailboxRunId}`;
        const epoch = ++this.mailboxDrainEpochCounter;
        this.mailboxDrainEpochs.set(key, epoch);
        return { key, epoch };
    }

    protected isMailboxDrainOwner(key: string, epoch: number): boolean {
        return this.mailboxDrainEpochs.get(key) === epoch;
    }

    protected releaseMailboxDrainEpoch(key: string, epoch: number): void {
        if (this.mailboxDrainEpochs.get(key) === epoch) {
            this.mailboxDrainEpochs.delete(key);
        }
    }

    /**
     * E-2：清理指定会话的全部 mailbox drain epoch 条目（对话删除/复用时可调用）。
     *
     * 当前 mailboxDrainEpochs 本身是有界 Map（每 (conversationId, runId) 一条，
     * 下次 claim 覆盖旧条目），配合生成器 finally 兜底释放（见 executeFunctionCallsWithProgress）
     * 后，泄漏面已收敛到「被永久放弃的生成器」与「已删除会话」的少量数字条目。
     * deleteConversation 的 A-COMM 信箱清理（agentMailbox.clearConversation）已由 FIX-G1 接线，
     * 本方法不重复接线，供需要同步清理 epoch 条目的调用点与测试使用。
     */
    clearMailboxDrainEpochsForConversation(conversationId: string): void {
        const prefix = `${conversationId}\u0000`;
        for (const key of this.mailboxDrainEpochs.keys()) {
            if (key.startsWith(prefix)) {
                this.mailboxDrainEpochs.delete(key);
            }
        }
    }

    /**
     * A-COMM：每次工具调用完成后检查当前 run 的 inbox，把 agent 消息追加到
     * 最近一次工具结果之后、与工具结果一起返回给模型（drain 语义，每条只投递一次）。
     *
     * 注入位置说明：
     * - functionResponse.response 顶层与 data 子对象同时注入（覆盖 formatter 的 JSON/文本两条序列化路径）；
     * - toolResult.result 同步注入（前端工具卡片可见）；
     * - 先校验注入目标（最近一次工具结果必须是 functionResponse part）再 drain：
     *   无注入目标时不消费 inbox，消息保留到下一次工具调用（FIX-B 5.2）；
     * - 未传 mailbox 身份或 inbox 为空时零开销直接返回，不影响既有行为。
     */
    protected injectInboxMessages(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined,
        responseParts: ContentPart[],
        toolResults: ToolExecutionResult[],
        mailboxDrainKey?: string,
        mailboxDrainEpoch?: number
    ): void {
        if (!mailboxConversationId || !mailboxRunId) {
            return;
        }

        // MED-1：并发执行循环共享 mailbox 身份时，只允许「最新启动」的循环 drain——
        // 早启动路径在主循环启动后只执行不 drain，消息统一挂在最终落盘的执行循环结果上
        if (mailboxDrainKey !== undefined && mailboxDrainEpoch !== undefined
            && !this.isMailboxDrainOwner(mailboxDrainKey, mailboxDrainEpoch)) {
            return;
        }

        // 先校验注入目标再 drain：最近一次工具结果必须是 functionResponse part，
        // 否则消息被消费后无处注入会丢失（FIX-B 5.2，防御性保护）
        const lastPart = responseParts[responseParts.length - 1];
        if (!lastPart?.functionResponse) {
            return;
        }
        const lastResult = toolResults[toolResults.length - 1];

        const messages = agentMailbox.drainMessages(mailboxConversationId, mailboxRunId);
        if (messages.length === 0) {
            return;
        }

        const inboxPayload = messages.map(m => ({
            fromRunId: m.fromRunId,
            ...(m.fromAgentName ? { fromAgentName: m.fromAgentName } : {}),
            text: m.text,
            threadId: m.threadId,
            hopDepth: m.hopDepth,
            createdAt: m.createdAt
        }));

        // 模型可见：追加到最近一次工具结果的 functionResponse.response。
        // 顶层与 data 子对象同时注入（覆盖 formatter 的 JSON/文本两条序列化路径，FIX-B 5.3 对齐注释与实现）
        const base = lastPart.functionResponse.response;
        const enrichedResponse: Record<string, unknown> = {
            ...(base && typeof base === 'object' ? (base as Record<string, unknown>) : {}),
            agentInbox: inboxPayload
        };
        if (enrichedResponse.data && typeof enrichedResponse.data === 'object') {
            enrichedResponse.data = {
                ...(enrichedResponse.data as Record<string, unknown>),
                agentInbox: inboxPayload
            };
        }
        lastPart.functionResponse.response = enrichedResponse;

        // 前端可见：同步注入 toolResult.result（含 data 子对象）
        if (lastResult?.result && typeof lastResult.result === 'object') {
            const result = lastResult.result as Record<string, unknown>;
            result.agentInbox = inboxPayload;
            const data = result.data;
            if (data && typeof data === 'object') {
                (data as Record<string, unknown>).agentInbox = inboxPayload;
            }
        }
    }

    /**
     * E-1：无主循环路径的显式 drain——把指定 (conversationId, runId) 的 inbox 消息
     * 注入给定结果（与 injectInboxMessages 相同的注入格式：functionResponse.response 顶层
     * 与 data 子对象 + toolResult.result）。
     *
     * 供 ToolIterationLoopService 在「流式边执行已完成、无主循环」（autoPrefix 为空）分支调用：
     * 此时早启动生成器不参与 drain（避免 abort 边角把已 drain 消息随被丢弃结果一起丢失，
     * 见 E-1），由本方法在最终落盘前显式消费一次。
     *
     * MED-1 收敛：调用方若持有 claim（mailboxDrainKey/mailboxDrainEpoch）则走与主循环一致的
     * 标准所有权检查；未传 claim 时（本路径无执行循环领取过 epoch）显式校验当前持有者——
     * 若已有并发的执行循环持有该 (conversationId, runId) 的 drain 权（如并发请求新启动的主循环），
     * 跳过本次消费，消息保留给新主循环，避免挂到将被丢弃的结果上；无持有者时本路径即最终落盘点，
     * 正常 drain。无注入目标（非 functionResponse part）时不消费 inbox。
     */
    drainInboxIntoResults(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined,
        responseParts: ContentPart[],
        toolResults: ToolExecutionResult[],
        mailboxDrainKey?: string,
        mailboxDrainEpoch?: number
    ): void {
        if (!mailboxConversationId || !mailboxRunId) {
            return;
        }

        if (mailboxDrainKey !== undefined && mailboxDrainEpoch !== undefined) {
            // 调用方持有 claim：走与主循环一致的所有权检查（injectInboxMessages 内校验）
            this.injectInboxMessages(
                mailboxConversationId,
                mailboxRunId,
                responseParts,
                toolResults,
                mailboxDrainKey,
                mailboxDrainEpoch
            );
            return;
        }

        // 调用方未持有 claim（无主循环路径）：MED-1 收敛——显式校验当前持有者。
        // 已有并发的执行循环持有该 (conversationId, runId) 的 drain 权时跳过本次消费，
        // 消息保留给新主循环（避免挂到将被丢弃的结果上）；无持有者时才正常 drain。
        // 本方法整体同步执行，check 与 drain 之间无 await，事件循环内原子。
        const key = `${mailboxConversationId}\u0000${mailboxRunId}`;
        if (this.mailboxDrainEpochs.has(key)) {
            return;
        }
        this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults);
    }
}

