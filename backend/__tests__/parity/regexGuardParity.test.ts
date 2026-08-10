/**
 * 跨端 parity：正则 ReDoS 护栏
 *
 * 同步点：backend/core/services/regexGuard.ts（完整版，223 行）
 *         vs frontend/src/utils/regexGuard.ts（简化版，16 行）
 *
 * 语义比对结论：部分一致 + 有意简化（后端完整版 ⊃ 前端简化版，近似而非等价）。
 *
 * 一致部分（本测试覆盖，两端对同一输入判定一致）：
 * - 长度上限同为 500（MAX_REGEX_SOURCE_LENGTH / MAX_UI_REGEX_SOURCE_LENGTH）
 * - 扁平"组内量词/分支 + 尾随量词"启发式：对共享词汇表（经典 (a+)+ 家族）判定一致
 * - 非法正则一律拒绝
 * - 常见安全模式（单组字面量、环视、定长量词等）一律放行
 *
 * 不一致部分（不在此断言——避免钉住缺陷阻碍未来修复，详见交付报告）：
 * - 前端无 sanitize（转义/字符类净化）→ 对字面括号 \(a+\)+、字符类 ([a+])+ 误报
 * - 前端组内量词类 [+*] 不含 ?（后端 [+*?]）→ 漏报 (a?)+
 * - 前端范围量词 {[^}]*} 不区分定长/可变（后端 \{\d+,\d*\}）→ 对 (a{2}){2}、(a+){2} 误报
 * - 前端无扫描式嵌套检测 → 漏报 (?:a+|(?:ab))+ 等跨层嵌套形态（后端 hasNestedQuantifiedGroups 拦截）
 * - 返回形状不同：后端 { ok:false, error } 带可读错误，前端返回 null（调用方不同，属接口设计差异）
 *
 * 测试方式：backend jest 直接 import 两端源码（前端 regexGuard 无任何依赖，可被 ts-jest 编译），
 * 表驱动行为比对——只断言"两端一致"的模式集合。
 */

import { validateRegexPattern, MAX_REGEX_SOURCE_LENGTH } from '../../core/services/regexGuard';
import { createSafeUiRegex, MAX_UI_REGEX_SOURCE_LENGTH } from '../../../frontend/src/utils/regexGuard';

function backendAccepts(pattern: string, flags?: string): boolean {
    return validateRegexPattern(pattern, flags).ok;
}

function frontendAccepts(pattern: string, flags?: string): boolean {
    return createSafeUiRegex(pattern, flags) !== null;
}

describe('跨端 parity：正则 ReDoS 护栏（core/services vs frontend utils）', () => {
    it('长度上限常量一致（均为 500）', () => {
        expect(MAX_UI_REGEX_SOURCE_LENGTH).toBe(MAX_REGEX_SOURCE_LENGTH);
        expect(MAX_REGEX_SOURCE_LENGTH).toBe(500);
    });

    it('长度边界行为一致：501 字符两端拒绝，500 字符两端放行', () => {
        expect(frontendAccepts('a'.repeat(501))).toBe(false);
        expect(backendAccepts('a'.repeat(501))).toBe(false);
        expect(frontendAccepts('a'.repeat(500))).toBe(true);
        expect(backendAccepts('a'.repeat(500))).toBe(true);
        // 带 flags 同样一致
        expect(frontendAccepts('a'.repeat(501), 'gi')).toBe(false);
        expect(backendAccepts('a'.repeat(501), 'gi')).toBe(false);
    });

    it.each([
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
    ])('危险模式两端一致拒绝：%s', (pattern) => {
        expect(backendAccepts(pattern)).toBe(false);
        expect(frontendAccepts(pattern)).toBe(false);
    });

    it.each([
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
    ])('安全模式两端一致放行：%s', (pattern) => {
        expect(backendAccepts(pattern)).toBe(true);
        expect(frontendAccepts(pattern)).toBe(true);
    });

    it('非法正则两端一致拒绝', () => {
        const invalidPatterns = ['([unclosed', 'a**b', '(?<name>', '\\'];
        for (const pattern of invalidPatterns) {
            expect(backendAccepts(pattern)).toBe(false);
            expect(frontendAccepts(pattern)).toBe(false);
        }
    });

    it('flags 行为一致（gi）且正确构造', () => {
        for (const pattern of ['foo\\d+', '(abc)+', 'a+b']) {
            expect(frontendAccepts(pattern, 'gi')).toBe(backendAccepts(pattern, 'gi'));
        }
        const regex = createSafeUiRegex('foo\\d+', 'gi');
        expect(regex).not.toBeNull();
        expect(regex!.flags).toContain('g');
        expect(regex!.flags).toContain('i');
        expect(regex!.test('FOO123')).toBe(true);
    });
});
