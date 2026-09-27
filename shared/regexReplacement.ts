/** 与 String.replace 的替换模板一致，供变化计数和实际替换共用。 */
export function expandReplacementTemplate(
    replacement: string,
    matchText: string,
    matchIndex: number,
    fullText: string,
    captureGroups: Array<string | undefined>,
    namedGroups?: Record<string, string | undefined>
): string {
    return replacement.replace(/\$(\$|&|\x60|'|\d{1,2}|<[^>]*>)/g, (token, ref: string) => {
        switch (ref) {
            case '$': return '$';
            case '&': return matchText;
            case '\x60': return fullText.slice(0, matchIndex);
            case "'": return fullText.slice(matchIndex + matchText.length);
        }
        if (ref.startsWith('<')) {
            // 有命名组但名称缺失时取空串；整个表达式没有命名组时才保留字面量。
            return namedGroups ? namedGroups[ref.slice(1, -1)] ?? '' : token;
        }
        // $01 可引用第一组；两位编号不存在时，尝试首位编号并保留第二位数字。
        const n = Number(ref);
        if (n > 0 && n <= captureGroups.length) return captureGroups[n - 1] ?? '';
        if (ref.length === 2) {
            const first = Number(ref[0]);
            if (first > 0 && first <= captureGroups.length) return (captureGroups[first - 1] ?? '') + ref[1];
        }
        return token;
    });
}
