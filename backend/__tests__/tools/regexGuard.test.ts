/**
 * regexGuard 共享正则护栏测试
 *
 * 覆盖：
 * - 长度上限：超长拒绝；恰好 500 字符可用
 * - 危险模式检测：嵌套量词（(a+)+、(a|a)+、(a{2,})*）拒绝；合法单组量词不误伤
 * - 构造异常：非法正则返回可读错误
 * - 合法正则正常构造并保留 flags
 */
import { validateRegexPattern, MAX_REGEX_SOURCE_LENGTH } from '../../tools/search/regexGuard';

describe('regexGuard 长度上限', () => {
    it('超长模式被拒绝并给出可读错误', () => {
        const result = validateRegexPattern('a'.repeat(MAX_REGEX_SOURCE_LENGTH + 1));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('too long');
        }
    });

    it('恰好 500 字符的模式仍可构造', () => {
        const result = validateRegexPattern('a'.repeat(MAX_REGEX_SOURCE_LENGTH));
        expect(result.ok).toBe(true);
    });
});

describe('regexGuard 危险模式检测（ReDoS）', () => {
    it('拒绝嵌套量词 (a+)+', () => {
        const result = validateRegexPattern('(a+)+');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('ReDoS');
        }
    });

    it('拒绝分支组 (a|a)+', () => {
        expect(validateRegexPattern('(a|a)+').ok).toBe(false);
    });

    it('拒绝范围量词组 (a{2,})*', () => {
        expect(validateRegexPattern('(a{2,})*').ok).toBe(false);
    });

    it('拒绝嵌套星号 (ab*c)*', () => {
        expect(validateRegexPattern('(ab*c)*').ok).toBe(false);
    });

    it('不误伤单组字面量 (abc)+', () => {
        const result = validateRegexPattern('(abc)+');
        expect(result.ok).toBe(true);
    });

    it('不误伤非嵌套 (a+)(b) 与 a+b', () => {
        expect(validateRegexPattern('(a+)(b)').ok).toBe(true);
        expect(validateRegexPattern('a+b').ok).toBe(true);
        expect(validateRegexPattern('(foo)*').ok).toBe(true);
    });
});

describe('regexGuard 构造与 flags', () => {
    it('非法正则给出可读错误', () => {
        const result = validateRegexPattern('([unclosed');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Invalid regular expression');
        }
    });

    it('合法正则正常构造并保留 flags', () => {
        const result = validateRegexPattern('foo\\d+', 'gi');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.regex.flags).toContain('g');
            expect(result.regex.flags).toContain('i');
            expect(result.regex.test('FOO123')).toBe(true);
        }
    });
});
