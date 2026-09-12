/** 桌面与扩展共用版本排序，保留现有 nightly 构建高于同号正式版的规则。 */
/** 剥离版本号前缀 v/V（GitHub tag 常见 v1.2.3） */
export function stripVersionPrefix(version: string): string {
    return String(version).replace(/^v/i, '');
}

/**
 * 语义版本比较（支持任意段数，缺段按 0；非数字段按 0）。
 * 主版本段相等时，预发布（-beta 等）判为更旧（同号预发布 < 正式）；
 * 同为预发布时按标识符逐段比较（数字段数值比较、字符串段字典序、段数多者更新、
 * 数字段 < 字母数字段），全部相等才判相等。
 * 特例：nightly 预发布（-nightly.<YYYYMMDD>）视为「高于同主版本正式版」的最新构建，
 * 两个 nightly 之间按日期段比较（1.4.6-nightly.20260810 > 1.4.6-nightly.20260809 > 1.4.6）。
 * 返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): {
        nums: number[];
        nightlyDate: string | null;
        prereleaseSegs: Array<string | number> | null;
        prerelease: boolean;
    } => {
        // 构建元数据不参与版本排序。
        const cleaned = stripVersionPrefix(v).split('+', 1)[0];
        const dash = cleaned.indexOf('-');
        const main = dash >= 0 ? cleaned.slice(0, dash) : cleaned;
        const suffix = dash >= 0 ? cleaned.slice(dash + 1) : null;
        const nightlyDate = suffix && suffix.startsWith('nightly.') ? suffix.slice('nightly.'.length) : null;
        // 预发布标识符段：纯数字段转数值（按数值比较），其余保留字符串（按字典序比较）
        const prereleaseSegs = suffix !== null && nightlyDate === null
            ? suffix.split('.').map(seg => (/^\d+$/.test(seg) ? parseInt(seg, 10) : seg))
            : null;
        return {
            nums: main.split('.').map(n => parseInt(n, 10) || 0),
            nightlyDate,
            prereleaseSegs,
            prerelease: prereleaseSegs !== null
        };
    };
    const ap = parse(a);
    const bp = parse(b);
    const len = Math.max(ap.nums.length, bp.nums.length);
    for (let i = 0; i < len; i++) {
        const x = ap.nums[i] ?? 0;
        const y = bp.nums[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    // 主版本相同：nightly 构建视为更新（nightly > 正式版；nightly 之间按日期）
    if (ap.nightlyDate || bp.nightlyDate) {
        if (ap.nightlyDate && bp.nightlyDate) {
            if (ap.nightlyDate !== bp.nightlyDate) return ap.nightlyDate < bp.nightlyDate ? -1 : 1;
            return 0;
        }
        return ap.nightlyDate ? 1 : -1;
    }
    if (ap.prerelease !== bp.prerelease) {
        return ap.prerelease ? -1 : 1;
    }
    // 同为预发布：按标识符逐段比较（1.4.6-beta vs 1.4.6-alpha、1.4.6-beta.1 vs 1.4.6-beta.2）
    if (ap.prereleaseSegs && bp.prereleaseSegs) {
        const segLen = Math.max(ap.prereleaseSegs.length, bp.prereleaseSegs.length);
        for (let i = 0; i < segLen; i++) {
            const x = ap.prereleaseSegs[i];
            const y = bp.prereleaseSegs[i];
            // 某一段缺失：段数少者更旧（1.0.0-alpha < 1.0.0-alpha.1）
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            if (x === y) continue;
            // 数字段与字母数字段相遇：数字段更旧（semver：numeric < alphanumeric）
            if (typeof x !== typeof y) {
                return typeof x === 'number' ? -1 : 1;
            }
            if (typeof x === 'number' && typeof y === 'number') {
                return x < y ? -1 : 1;
            }
            return String(x) < String(y) ? -1 : 1;
        }
    }
    return 0;
}

/**
 * nightly 版本号格式：<semver>-nightly.<YYYYMMDD>（如 1.4.6-nightly.20260809）。
 * 合法 semver（vsce 打包校验要求）；compareVersions 将 nightly 预发布视为
 * 「高于同主版本正式版」的最新构建，nightly 之间按日期比较。
 */
const NIGHTLY_VERSION_RE = /(?<![\d.])(\d+\.\d+\.\d+-nightly\.\d{8})\b/i;

/**
 * 从 nightly Release 名称中提取版本号。
 * 例如 "v1.4.6-nightly.20260809" → "1.4.6-nightly.20260809"；
 * 同时兼容旧的 "Gray Code Nightly v..." 名称。
 * 提取失败返回 null。
 */
export function extractNightlyVersionFromName(name: unknown): string | null {
    if (typeof name !== 'string' || !name) return null;
    const m = NIGHTLY_VERSION_RE.exec(name);
    return m ? m[1] : null;
}

