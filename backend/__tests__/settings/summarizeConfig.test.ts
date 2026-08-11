/**
 * SummarizeConfig 新字段与收敛逻辑测试。
 *
 * 覆盖：
 * - 默认配置携带 maxAutoSummarizeAttemptsPerTurn / summarizeMaxInputRatio；
 * - clampMaxAutoSummarizeAttempts：缺省/非法回落 2，范围钳制 [1,5] 整数；
 * - clampSummarizeMaxInputRatio：缺省/非法回落 0.5，范围钳制 [0.05,0.95]。
 */

import {
    DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    DEFAULT_SUMMARIZE_CONFIG,
    DEFAULT_SUMMARIZE_MAX_INPUT_RATIO,
    clampMaxAutoSummarizeAttempts,
    clampSummarizeMaxInputRatio
} from '../../modules/settings/types/summarizeTypes';

describe('DEFAULT_SUMMARIZE_CONFIG', () => {
    test('包含两个新字段的默认值', () => {
        expect(DEFAULT_SUMMARIZE_CONFIG.maxAutoSummarizeAttemptsPerTurn).toBe(2);
        expect(DEFAULT_SUMMARIZE_CONFIG.summarizeMaxInputRatio).toBe(0.5);
        expect(DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN).toBe(2);
        expect(DEFAULT_SUMMARIZE_MAX_INPUT_RATIO).toBe(0.5);
    });
});

describe('clampMaxAutoSummarizeAttempts', () => {
    test('缺省/非法值回落默认 2', () => {
        expect(clampMaxAutoSummarizeAttempts(undefined)).toBe(2);
        expect(clampMaxAutoSummarizeAttempts(null)).toBe(2);
        expect(clampMaxAutoSummarizeAttempts('3')).toBe(2);
        expect(clampMaxAutoSummarizeAttempts(NaN)).toBe(2);
        expect(clampMaxAutoSummarizeAttempts(Infinity)).toBe(2);
    });

    test('合法值原样保留', () => {
        expect(clampMaxAutoSummarizeAttempts(1)).toBe(1);
        expect(clampMaxAutoSummarizeAttempts(2)).toBe(2);
        expect(clampMaxAutoSummarizeAttempts(5)).toBe(5);
    });

    test('范围外钳制，小数向下取整', () => {
        expect(clampMaxAutoSummarizeAttempts(0)).toBe(1);
        expect(clampMaxAutoSummarizeAttempts(-3)).toBe(1);
        expect(clampMaxAutoSummarizeAttempts(9)).toBe(5);
        expect(clampMaxAutoSummarizeAttempts(2.9)).toBe(2);
        expect(clampMaxAutoSummarizeAttempts(0.5)).toBe(1);
    });
});

describe('clampSummarizeMaxInputRatio', () => {
    test('缺省/非法值回落默认 0.5', () => {
        expect(clampSummarizeMaxInputRatio(undefined)).toBe(0.5);
        expect(clampSummarizeMaxInputRatio(null)).toBe(0.5);
        expect(clampSummarizeMaxInputRatio('50%')).toBe(0.5);
        expect(clampSummarizeMaxInputRatio(NaN)).toBe(0.5);
    });

    test('合法值原样保留', () => {
        expect(clampSummarizeMaxInputRatio(0.1)).toBe(0.1);
        expect(clampSummarizeMaxInputRatio(0.5)).toBe(0.5);
        expect(clampSummarizeMaxInputRatio(0.9)).toBe(0.9);
    });

    test('范围外钳制到 [0.05, 0.95]', () => {
        expect(clampSummarizeMaxInputRatio(0.01)).toBe(0.05);
        expect(clampSummarizeMaxInputRatio(0)).toBe(0.05);
        expect(clampSummarizeMaxInputRatio(1)).toBe(0.95);
        expect(clampSummarizeMaxInputRatio(2)).toBe(0.95);
    });
});
