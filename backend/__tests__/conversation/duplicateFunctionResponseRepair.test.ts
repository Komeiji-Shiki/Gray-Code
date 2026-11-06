/**
 * 重复 functionResponse 清理（duplicate_function_response_id）。
 *
 * 事故形态：读取路径的悬空调用补齐把"结果尚未落盘"的在途调用误写成"用户拒绝"占位，
 * 真实工具结果随后照常落盘 → 同一调用两条响应 → 下一次模型请求被历史完整性校验拒绝
 * （API_ERROR: Unpaired tool history）。
 *
 * 修复分三层：
 * - 纯函数 repairDuplicateFunctionResponses：同一 ID 只保留一条响应（优先真实结果），
 *   清除真实响应上残留的 rejected 标记，删除被清空的占位消息并修正 parentId 链；
 * - 读取路径由平台 historyView 在存储版本保护下修复并写回，补齐跳过活跃任务的在途调用
 *   （packages/core/tests/historyRepairConcurrency.test.ts）。
 * 本文件只覆盖纯函数。
 */

import type { ConversationHistory, Content } from '../../modules/conversation/types';
import { repairDuplicateFunctionResponses, isPlaceholderToolResponse } from '../../modules/conversation/manager/historyRepair';
import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';

/**
 * 事故数据形态：占位先写入（无 runId、无时间戳），真实结果随后追加（属于活跃任务）。
 * parentId 链与真实存储一致（线性）。
 */
function historyWithDuplicateResponse(): ConversationHistory {
    return [
        { role: 'user', id: 'u1', parentId: null, parts: [{ text: '继续' }], isUserInput: true, timestamp: 100 },
        {
            role: 'model', id: 'm1', parentId: 'u1', timestamp: 200,
            parts: [
                { text: '开始执行' },
                { functionCall: { id: 'call_a', name: 'read_file', args: { path: 'a.ts' }, rejected: true } },
                { functionCall: { id: 'call_b', name: 'read_file', args: { path: 'b.ts' }, rejected: true } },
            ],
        },
        {
            role: 'user', id: 'fr-placeholder', parentId: 'm1', isFunctionResponse: true, timestamp: 250,
            parts: [
                { functionResponse: { id: 'call_a', name: 'read_file', response: { success: false, error: '用户拒绝执行此工具', rejected: true } } },
                { functionResponse: { id: 'call_b', name: 'read_file', response: { success: false, error: '用户拒绝执行此工具', rejected: true } } },
            ],
        },
        {
            role: 'user', id: 'fr-real-a', parentId: 'fr-placeholder', isFunctionResponse: true, runId: 'run_live', timestamp: 300,
            parts: [{ functionResponse: { id: 'call_a', name: 'read_file', response: { success: true, data: 'A' } } }],
        },
        {
            role: 'user', id: 'fr-real-b', parentId: 'fr-real-a', isFunctionResponse: true, runId: 'run_live', timestamp: 301,
            parts: [{ functionResponse: { id: 'call_b', name: 'read_file', response: { success: true, data: 'B' } } }],
        },
    ] as ConversationHistory;
}

describe('repairDuplicateFunctionResponses 纯函数', () => {
    test('占位判定只认结构标记，不依赖界面文案', () => {
        expect(isPlaceholderToolResponse({ rejected: true })).toBe(true);
        expect(isPlaceholderToolResponse({ cancelled: true })).toBe(true);
        expect(isPlaceholderToolResponse({ success: false, code: 'CANCELLED' })).toBe(true);
        expect(isPlaceholderToolResponse({ success: false, code: 'INTERRUPTED' })).toBe(true);
        expect(isPlaceholderToolResponse({ success: true, data: 'x' })).toBe(false);
        expect(isPlaceholderToolResponse(null)).toBe(false);
    });

    test('同一调用的重复响应只保留真实结果，占位消息整条删除并修正 parentId 链', () => {
        const result = repairDuplicateFunctionResponses(historyWithDuplicateResponse());

        expect(result.changed).toBe(true);
        expect(result.history.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);
        // 真实响应保留、rejected 标记清除（占位配套的"无响应是有意"不再成立）
        expect(result.history[1].parts[1].functionCall?.rejected).toBe(false);
        expect(result.history[1].parts[2].functionCall?.rejected).toBe(false);
        // 被删占位消息（fr-placeholder）的下一条重新指向 m1；再之后保持原链
        expect(result.history[2].parentId).toBe('m1');
        expect(result.history[3].parentId).toBe('fr-real-a');

        // 幂等：修复后的历史不再有变更，且返回原引用
        const second = repairDuplicateFunctionResponses(result.history);
        expect(second.changed).toBe(false);
        expect(second.history).toBe(result.history);
    });

    test('同一调用只有占位响应时保留最后一条，拒绝语义不破坏', () => {
        const history = [
            { role: 'model', id: 'm0', parts: [{ functionCall: { id: 'call_x', name: 'read_file', args: {}, rejected: true } }] },
            { role: 'user', id: 'p1', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: false, error: 'a', rejected: true } } }] },
            { role: 'user', id: 'p2', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: false, error: 'b', cancelled: true } } }] },
        ] as ConversationHistory;
        const result = repairDuplicateFunctionResponses(history);

        expect(result.changed).toBe(true);
        expect(result.history.map(message => message.id)).toEqual(['m0', 'p2']);
        // 全是占位：调用保持 rejected（拒绝是设计语义）
        expect(result.history[0].parts[0].functionCall?.rejected).toBe(true);
    });

    test('真实响应上残留的 rejected 标记会被清除（无重复也自愈）', () => {
        const history = [
            { role: 'model', id: 'm1', parts: [{ functionCall: { id: 'call_x', name: 'read_file', args: {}, rejected: true } }] },
            { role: 'user', id: 'f1', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: true } } }] },
        ] as ConversationHistory;
        const result = repairDuplicateFunctionResponses(history);

        expect(result.changed).toBe(true);
        expect(result.history[0].parts[0].functionCall?.rejected).toBe(false);
    });
});
