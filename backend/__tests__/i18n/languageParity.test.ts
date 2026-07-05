/**
 * i18n 语言包一致性测试
 *
 * 校验 backend 与 frontend 各自的 en / ja / zh-CN 三份语言包：
 * 1. key 集合完全一致（防漏译、防孤儿 key）
 * 2. 每条文案中的 {placeholder} 占位符集合一致（防翻译时丢参数）
 */

import backendEn from '../../i18n/langs/en';
import backendJa from '../../i18n/langs/ja';
import backendZh from '../../i18n/langs/zh-CN';

import frontendEn from '../../../frontend/src/i18n/langs/en';
import frontendJa from '../../../frontend/src/i18n/langs/ja';
import frontendZh from '../../../frontend/src/i18n/langs/zh-CN';

type MessageTree = Record<string, unknown>;

/** 递归收集叶子 key（点分路径 -> 文案字符串） */
function collectLeaves(tree: MessageTree, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
    for (const [key, value] of Object.entries(tree)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            out.set(path, value);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            collectLeaves(value as MessageTree, path, out);
        } else {
            // 数组或其他类型也记录为叶子，保证结构差异能被发现
            out.set(path, JSON.stringify(value));
        }
    }
    return out;
}

/** 提取文案中的 {placeholder} 集合 */
function extractPlaceholders(text: string): string[] {
    const matches = text.match(/\{[a-zA-Z0-9_]+\}/g) ?? [];
    return [...new Set(matches)].sort();
}

function diffKeys(base: Map<string, string>, other: Map<string, string>): { missing: string[]; extra: string[] } {
    const missing = [...base.keys()].filter(k => !other.has(k));
    const extra = [...other.keys()].filter(k => !base.has(k));
    return { missing, extra };
}

function expectSameKeys(name: string, base: Map<string, string>, other: Map<string, string>) {
    const { missing, extra } = diffKeys(base, other);
    if (missing.length > 0 || extra.length > 0) {
        const details = [
            missing.length > 0 ? `missing (${missing.length}): ${missing.slice(0, 20).join(', ')}` : '',
            extra.length > 0 ? `extra (${extra.length}): ${extra.slice(0, 20).join(', ')}` : ''
        ].filter(Boolean).join('\n');
        throw new Error(`[${name}] language pack keys mismatch:\n${details}`);
    }
}

function expectSamePlaceholders(name: string, base: Map<string, string>, other: Map<string, string>) {
    const mismatches: string[] = [];
    for (const [key, baseText] of base) {
        const otherText = other.get(key);
        if (typeof otherText !== 'string') continue;
        const basePh = extractPlaceholders(baseText).join(',');
        const otherPh = extractPlaceholders(otherText).join(',');
        if (basePh !== otherPh) {
            mismatches.push(`${key}: [${basePh}] vs [${otherPh}]`);
        }
    }
    if (mismatches.length > 0) {
        throw new Error(
            `[${name}] placeholder mismatch (${mismatches.length}):\n${mismatches.slice(0, 30).join('\n')}`
        );
    }
}

describe('backend i18n language packs', () => {
    const en = collectLeaves(backendEn as unknown as MessageTree);
    const ja = collectLeaves(backendJa as unknown as MessageTree);
    const zh = collectLeaves(backendZh as unknown as MessageTree);

    it('en/ja/zh-CN have identical key sets', () => {
        expectSameKeys('backend en vs ja', en, ja);
        expectSameKeys('backend en vs zh-CN', en, zh);
    });

    it('placeholders are consistent across languages', () => {
        expectSamePlaceholders('backend en vs ja', en, ja);
        expectSamePlaceholders('backend en vs zh-CN', en, zh);
    });
});

describe('frontend i18n language packs', () => {
    const en = collectLeaves(frontendEn as unknown as MessageTree);
    const ja = collectLeaves(frontendJa as unknown as MessageTree);
    const zh = collectLeaves(frontendZh as unknown as MessageTree);

    it('en/ja/zh-CN have identical key sets', () => {
        expectSameKeys('frontend en vs ja', en, ja);
        expectSameKeys('frontend en vs zh-CN', en, zh);
    });

    it('placeholders are consistent across languages', () => {
        expectSamePlaceholders('frontend en vs ja', en, ja);
        expectSamePlaceholders('frontend en vs zh-CN', en, zh);
    });
});
