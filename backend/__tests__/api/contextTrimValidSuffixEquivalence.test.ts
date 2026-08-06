/**
 * L-5 回归测试：computeValidSuffixMap 与 validateHistoryIntegrity 的语义等价性。
 *
 * 背景：computeValidSuffixMap（反向单趟 O(n) 预计算）替代了 normalizeTrimStartIndex 对
 * 每个候选起点逐次 slice + validateHistoryIntegrity 的 O(n²) 校验。反向扫描的「治愈」逻辑
 * 必须与正向校验逐位等价——特别是乱序配对（functionResponse 出现在其配对 functionCall
 * 之前，含跨消息与同消息内两种形态）时，正向判孤儿（invalid）而旧反向实现误判 valid。
 *
 * 覆盖：正常配对 / 跨消息乱序 / 同消息乱序 / 同消息正常 / 重复 call / 重复 response /
 * 混合多轮 + 随机模糊对比（固定 seed）。
 */

import { ContextTrimService } from '../../modules/api/chat/services/ContextTrimService';
import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../modules/conversation/types';

describe('L-5: computeValidSuffixMap 与 validateHistoryIntegrity 语义等价', () => {
    function createHarness() {
        const conversationManager = {
            getHistoryRef: jest.fn(),
            getHistoryForAPIFrom: jest.fn(),
            getCustomMetadata: jest.fn().mockResolvedValue(undefined),
            setCustomMetadata: jest.fn(),
            invalidateContextManagementState: jest.fn()
        };
        const promptManager = {
            getSystemPrompt: jest.fn(() => ''),
            getDynamicContextText: jest.fn(() => '')
        };
        const tokenEstimationService = {
            countTextTokensBatch: jest.fn().mockResolvedValue([0, 0]),
            preCountUserMessageTokensBatch: jest.fn().mockResolvedValue(undefined),
            estimateMessageTokens: jest.fn(() => 100)
        };
        const service = new ContextTrimService(
            conversationManager as any,
            promptManager as any,
            tokenEstimationService as any,
            {} as any
        );
        return service;
    }

    function callPart(id: string) {
        return { functionCall: { id, name: 'tool', args: {} } };
    }

    function responsePart(id: string) {
        return { functionResponse: { id, name: 'tool', response: { ok: true } } };
    }

    function textPart(text: string) {
        return { text };
    }

    function msg(role: 'user' | 'model', parts: Record<string, unknown>[]): Content {
        return { role, parts: parts as Content['parts'] };
    }

    /** 断言 validSuffixMap 与「逐候选 slice + validateHistoryIntegrity」完全一致 */
    function assertEquivalent(service: ContextTrimService, history: Content[]) {
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        const expected = history.map((_, i) => validateHistoryIntegrity(history.slice(i)).valid);
        expect(map).toEqual(expected);
    }

    it('正常跨消息配对：call 在左、response 在右', () => {
        const service = createHarness();
        const history = [
            msg('model', [callPart('x')]),
            msg('user', [responsePart('x')]),
            msg('model', [textPart('done')])
        ];
        // slice(0) valid；slice(1)=[response] 孤儿 invalid；slice(2) valid
        assertEquivalent(service, history);
    });

    it('跨消息乱序配对：response 在左、call 在右（正向判孤儿，旧实现误判 valid）', () => {
        const service = createHarness();
        const history = [
            msg('user', [responsePart('x')]),
            msg('model', [callPart('x')])
        ];
        // slice(0)=[response, call]：正向中 response 先出现时 call 未 seen → 孤儿 → invalid
        // slice(1)=[call]：valid
        assertEquivalent(service, history);
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        expect(map[0]).toBe(false);
        expect(map[1]).toBe(true);
    });

    it('同消息正常配对：同一消息内 call part 在 response part 之前', () => {
        const service = createHarness();
        const history = [
            msg('model', [callPart('x'), responsePart('x')]),
            msg('model', [textPart('done')])
        ];
        assertEquivalent(service, history);
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        expect(map[0]).toBe(true);
    });

    it('同消息乱序配对：同一消息内 response part 在 call part 之前（正向判孤儿）', () => {
        const service = createHarness();
        const history = [
            msg('model', [responsePart('x'), callPart('x')]),
            msg('model', [textPart('done')])
        ];
        assertEquivalent(service, history);
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        expect(map[0]).toBe(false);
    });

    it('重复 functionCall id', () => {
        const service = createHarness();
        const history = [
            msg('model', [callPart('x')]),
            msg('model', [callPart('x')]),
            msg('user', [responsePart('x')])
        ];
        assertEquivalent(service, history);
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        // slice(1)=[call x, response x] 恰好配对 → valid；slice(0) 重复 call → invalid
        expect(map[1]).toBe(true);
        expect(map[0]).toBe(false);
    });

    it('重复 functionResponse id', () => {
        const service = createHarness();
        const history = [
            msg('model', [callPart('x')]),
            msg('user', [responsePart('x')]),
            msg('user', [responsePart('x')])
        ];
        assertEquivalent(service, history);
        const map = (service as any).computeValidSuffixMap(history) as boolean[];
        expect(map[0]).toBe(false);
    });

    it('多轮工具循环 + 尾部孤儿 response + 中间普通文本', () => {
        const service = createHarness();
        const history = [
            msg('user', [textPart('hi')]),
            msg('model', [callPart('a')]),
            msg('user', [responsePart('a')]),
            msg('model', [callPart('b')]),
            msg('user', [responsePart('b')]),
            msg('model', [textPart('done')]),
            msg('user', [responsePart('orphan')])  // 无配对 call 的孤儿响应
        ];
        assertEquivalent(service, history);
    });

    it('随机模糊对比（固定 seed，覆盖随机 call/response 顺序与 id 复用）', () => {
        const service = createHarness();
        // 简单 LCG 伪随机（固定 seed 保证可复现）
        let seed = 42;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let round = 0; round < 50; round++) {
            const idCount = 1 + Math.floor(rand() * 3);
            const history: Content[] = [];
            const msgCount = 2 + Math.floor(rand() * 8);
            for (let m = 0; m < msgCount; m++) {
                const parts: Record<string, unknown>[] = [];
                const partCount = 1 + Math.floor(rand() * 3);
                for (let p = 0; p < partCount; p++) {
                    const kind = Math.floor(rand() * 3);
                    const id = `id-${Math.floor(rand() * idCount)}`;
                    if (kind === 0) parts.push(callPart(id));
                    else if (kind === 1) parts.push(responsePart(id));
                    else parts.push(textPart(`t${round}-${m}-${p}`));
                }
                history.push(msg(rand() > 0.5 ? 'model' : 'user', parts));
            }
            assertEquivalent(service, history);
        }
    });
});
