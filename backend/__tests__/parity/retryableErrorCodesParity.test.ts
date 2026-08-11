/**
 * 跨端 parity：可重试错误码集合
 *
 * 同步点：frontend/src/stores/chat/messageActions/retryFlows.ts 的 RETRYABLE_ERROR_CODES
 *         vs backend/core/errors.ts 的 RETRYABLE_ERROR_TYPES
 * （两端注释均声明"同步维护"，因 tsconfig 跨端限制无法共享代码。）
 *
 * 语义比对结论（现状，非子集关系）：
 * - 共同核心（语义一致）：API_ERROR / NETWORK_ERROR / TIMEOUT_ERROR / EMPTY_RESPONSE_ERROR
 *   两端均可重试（EMPTY_RESPONSE_ERROR 为第七批前端补录后两端一致）。
 * - 前端独有（有意，注释自证）：STREAM_ERROR / RETRY_ERROR / EDIT_RETRY_ERROR（前端自有码，
 *   不属于后端 ErrorType 词汇表）。
 * - 前端独有（已裁决的有意差异）：PARSE_ERROR —— 前端 FIX-C-1 注释判定"可重试"
 *   （错误条手动重试按钮放行）；后端 errors.ts 明确 "PARSE_ERROR 不在白名单内，均不可重试"
 *   （ChannelManager 自动重试不放行）。裁决：维持现状行为，两端注释互相引用，
 *   属有意差异（手动重试 vs 自动重试语义）而非遗漏。
 *
 * 测试策略：parity 快照（不断言两端相等——现状不相等）。
 * 本测试钉住"已知偏差集"：任何一端增删可重试码导致偏差集变化时，测试失败并提示人工同步。
 * 若两端日后收敛（如后端将 PARSE_ERROR 加入白名单），需同步更新下方 KNOWN_* 常量。
 */

import * as fs from 'fs';
import * as path from 'path';

import { RETRYABLE_ERROR_TYPES } from '../../core/errors';
import { ErrorType } from '../../modules/channel/types';

const FRONTEND_RETRY_FLOWS_SOURCE = path.resolve(
    __dirname,
    '../../../frontend/src/stores/chat/messageActions/retryFlows.ts'
);

/** 前端自有错误码（非后端 ErrorType 词汇表；retryFlows.ts 注释自证的有意差异） */
const FRONTEND_OWNED_CODES: readonly string[] = ['STREAM_ERROR', 'RETRY_ERROR', 'EDIT_RETRY_ERROR'];

/** 已记录偏差：后端可重试、前端未收录（后端独有）——第七批已补录 EMPTY_RESPONSE_ERROR，现为空 */
const KNOWN_BACKEND_ONLY: readonly string[] = [];

/** 已记录偏差：前端可重试、后端明确不可重试（前端独有）——已裁决为有意差异（手动重试语义），行为不变 */
const KNOWN_FRONTEND_ONLY: readonly string[] = ['PARSE_ERROR'];

/**
 * 从前端源码提取 RETRYABLE_ERROR_CODES 的 Set 字面量成员。
 * 不 import 整个模块（retryFlows.ts 依赖前端 store 链，无法在 backend jest 加载）。
 * 09 批 M4 加固：正则容忍类型注解变体（ReadonlySet<string>/Set<string>）与
 * 空白/换行差异（`]` 与 `)` 不再要求相邻），避免纯格式化重构误报；
 * 仅当 Set 字面量结构本身变化（改名/改写法）时才 fail-loud 提示人工同步。
 */
function extractFrontendRetryableCodes(): string[] {
    const source = fs.readFileSync(FRONTEND_RETRY_FLOWS_SOURCE, 'utf8');
    const literal = source.match(
        /export const RETRYABLE_ERROR_CODES\s*:\s*(?:ReadonlySet<string>|Set<string>)\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/
    );
    if (!literal) {
        throw new Error(
            '无法从前端 retryFlows.ts 提取 RETRYABLE_ERROR_CODES 数组字面量——文件结构可能已变化，请同步更新本测试'
        );
    }
    return [...literal[1].matchAll(/['"]([A-Z_]+)['"]/g)].map((m) => m[1]);
}

describe('跨端 parity：可重试错误码集合（retryFlows.ts vs core/errors.ts）', () => {
    const frontendCodes = extractFrontendRetryableCodes();
    const frontendSet = new Set(frontendCodes);
    const backendTypes = [...RETRYABLE_ERROR_TYPES] as string[];
    const backendSet = new Set(backendTypes);
    const backendVocabulary = Object.values(ErrorType) as string[];

    test('前端集合包含三个前端自有码（STREAM_ERROR / RETRY_ERROR / EDIT_RETRY_ERROR）', () => {
        for (const code of FRONTEND_OWNED_CODES) {
            expect(frontendSet.has(code)).toBe(true);
        }
    });

    test('前端集合不包含后端词汇表之外的未知码', () => {
        const unexpected = frontendCodes.filter(
            (c) => !backendVocabulary.includes(c) && !FRONTEND_OWNED_CODES.includes(c)
        );
        expect(unexpected).toEqual([]);
    });

    test('后端可重试 ErrorType 均被前端收录（除已记录偏差 KNOWN_BACKEND_ONLY，现为空）', () => {
        // 后端白名单新增可重试类型而前端未同步 → missing 变多，本测试失败（防漂移）
        const missing = backendTypes.filter((t) => !frontendSet.has(t));
        expect(missing).toEqual([...KNOWN_BACKEND_ONLY]);
    });

    test('前端收录的后端词汇表错误码均在后端白名单内（除已记录偏差 KNOWN_FRONTEND_ONLY）', () => {
        // 前端新增可重试的后端词汇表码而后端未收录 → extra 变多，本测试失败（防漂移）
        const extra = frontendCodes.filter((c) => backendVocabulary.includes(c) && !backendSet.has(c));
        expect(extra).toEqual([...KNOWN_FRONTEND_ONLY]);
    });

    test('共同核心 API_ERROR / NETWORK_ERROR / TIMEOUT_ERROR 两端一致可重试', () => {
        for (const code of ['API_ERROR', 'NETWORK_ERROR', 'TIMEOUT_ERROR']) {
            expect(backendSet.has(code)).toBe(true);
            expect(frontendSet.has(code)).toBe(true);
        }
    });
});