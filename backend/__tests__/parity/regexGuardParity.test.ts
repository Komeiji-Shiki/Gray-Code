/**
 * 跨端 parity：正则 ReDoS 护栏（单一来源合并后）
 *
 * 同步点：shared/regexGuard.ts（跨端统一单一来源，完整逻辑）
 *         backend/core/services/regexGuard.ts（re-export shared）
 *         frontend/src/utils/regexGuard.ts（壳 createSafeUiRegex + re-export shared）
 *
 * 方案 A 合并后两端不再是"近似一致"：后端与前端核心判定为 shared 的同一函数实例，
 * 本测试断言：
 * - 两端关键函数与 shared === 同一实例（单一来源，杜绝分叉）
 * - 导出面一致（shared 全部核心符号两端均可导入；前端另有端侧壳与别名常量）
 * - 原有行为断言保留（长度边界、危险/安全模式表、非法正则、flags），
 *   并纳入此前 6 个差异模式（4 误报 + 2 漏报）——合并后两端判定统一
 *
 * 09 批 M4 约束更新：本测试直接 import 前端文件路径；前端 regexGuard 依赖 @shared
 * （jest.backend.config.js 的 moduleNameMapper 已映射 ^@shared/ → shared/，
 * tsconfig.test.json 的 paths 已对应），backend jest 可正常编译。
 */

import * as backendRegexGuard from '../../core/services/regexGuard';
import * as frontendRegexGuard from '../../../frontend/src/utils/regexGuard';
import * as sharedRegexGuard from '../../../shared/regexGuard';

function backendAccepts(pattern: string, flags?: string): boolean {
    return backendRegexGuard.validateRegexPattern(pattern, flags).ok;
}

function frontendAccepts(pattern: string, flags?: string): boolean {
    return frontendRegexGuard.createSafeUiRegex(pattern, flags) !== null;
}

describe('跨端 parity：正则 ReDoS 护栏（单一来源合并后）', () => {
    test('两端核心函数与 shared === 同一实例（单一来源，无分叉）', () => {
        expect(backendRegexGuard.validateRegexPattern).toBe(sharedRegexGuard.validateRegexPattern);
        expect(backendRegexGuard.hasNestedQuantifiedGroups).toBe(sharedRegexGuard.hasNestedQuantifiedGroups);
        expect(backendRegexGuard.MAX_REGEX_SOURCE_LENGTH).toBe(sharedRegexGuard.MAX_REGEX_SOURCE_LENGTH);
        expect(frontendRegexGuard.validateRegexPattern).toBe(sharedRegexGuard.validateRegexPattern);
        expect(frontendRegexGuard.hasNestedQuantifiedGroups).toBe(sharedRegexGuard.hasNestedQuantifiedGroups);
        expect(frontendRegexGuard.MAX_REGEX_SOURCE_LENGTH).toBe(sharedRegexGuard.MAX_REGEX_SOURCE_LENGTH);
    });

    test('导出面一致：shared 全部核心符号两端均可导入；前端另有端侧壳与别名', () => {
        const sharedNames = Object.keys(sharedRegexGuard).sort();
        expect(sharedNames).toEqual(['MAX_REGEX_SOURCE_LENGTH', 'hasNestedQuantifiedGroups', 'validateRegexPattern']);
        const backendNames = Object.keys(backendRegexGuard).sort();
        const frontendNames = Object.keys(frontendRegexGuard).sort();
        for (const name of sharedNames) {
            expect(backendNames).toContain(name);
            expect(frontendNames).toContain(name);
        }
        // 端侧专属导出：前端壳与别名常量
        expect(frontendNames).toContain('createSafeUiRegex');
        expect(frontendNames).toContain('MAX_UI_REGEX_SOURCE_LENGTH');
    });

    test('长度上限常量一致（均为 500）', () => {
        expect(frontendRegexGuard.MAX_UI_REGEX_SOURCE_LENGTH).toBe(sharedRegexGuard.MAX_REGEX_SOURCE_LENGTH);
        expect(sharedRegexGuard.MAX_REGEX_SOURCE_LENGTH).toBe(500);
    });

    test('长度边界行为一致：501 字符两端拒绝，500 字符两端放行', () => {
        expect(frontendAccepts('a'.repeat(501))).toBe(false);
        expect(backendAccepts('a'.repeat(501))).toBe(false);
        expect(frontendAccepts('a'.repeat(500))).toBe(true);
        expect(backendAccepts('a'.repeat(500))).toBe(true);
        // 带 flags 同样一致
        expect(frontendAccepts('a'.repeat(501), 'gi')).toBe(false);
        expect(backendAccepts('a'.repeat(501), 'gi')).toBe(false);
    });

    test.each([
        '(a+)+',
        '(a*)*',
        '(a|a)+',
        '(a{2,})*',
        '(a{2,})+',
        '(ab*c)*',
        '(a|aa)+',
        '(a+){2,}',
        '((a+)+)+',
        '((a|a)+)+',
        '((a+)+){2}',
        '((a+)+)?',
        '(?<name>a+)+',
        // 2 漏报（此前前端放行、后端拦截）——合并后两端一致拒绝
        '(a?)+',
        '(?:a+|(?:ab))+',
    ])('危险模式两端一致拒绝：%s', (pattern) => {
        expect(backendAccepts(pattern)).toBe(false);
        expect(frontendAccepts(pattern)).toBe(false);
    });

    test.each([
        '(abc)+',
        '(foo)*',
        '(abc)?',
        '(a+)?',
        '(?:ab)+',
        '(?=a)b',
        '(?!a)b',
        '(?<=a)b',
        'a{2,3}',
        '(foo){2}',
        '(ab|cd)',
        'a+b',
        '(a+)(b)',
        '[a|b]+',
        'foo\\d+',
        '(?<name>abc)+',
        '(?:a|(?:ab))+',
        // 4 误报（此前前端拦截、后端放行）——合并后两端一致放行
        '\\(a+\\\)+',
        '([a+])+',
        '(a{2}){2}',
        '(a+){2}',
    ])('安全模式两端一致放行：%s', (pattern) => {
        expect(backendAccepts(pattern)).toBe(true);
        expect(frontendAccepts(pattern)).toBe(true);
    });

    test('非法正则两端一致拒绝', () => {
        const invalidPatterns = ['([unclosed', 'a**b', '(?<name>', '\\'];
        for (const pattern of invalidPatterns) {
            expect(backendAccepts(pattern)).toBe(false);
            expect(frontendAccepts(pattern)).toBe(false);
        }
    });

    test('flags 行为一致（gi）且正确构造', () => {
        for (const pattern of ['foo\\d+', '(abc)+', 'a+b']) {
            expect(frontendAccepts(pattern, 'gi')).toBe(backendAccepts(pattern, 'gi'));
        }
        const regex = frontendRegexGuard.createSafeUiRegex('foo\\d+', 'gi');
        expect(regex).not.toBeNull();
        expect(regex!.flags).toContain('g');
        expect(regex!.flags).toContain('i');
        expect(regex!.test('FOO123')).toBe(true);
    });
});
