/**
 * i18n 共享词条生成物一致性测试（防 drift）
 *
 * 背景：backend/i18n/langs 与 frontend/src/i18n/langs 各有一份语言包，
 * 同一词条曾两边各写一遍。现通过 scripts/i18n-sync.mjs 建立单一来源机制：
 *   - 单一来源：backend/i18n/langs/{zh-CN,en,ja}.ts（手写）
 *   - 映射登记：scripts/i18n-shared-manifest.json（frontend key -> backend key）
 *   - 生成物：frontend/src/i18n/langs/_shared/{zh-CN,en,ja}.ts（AUTO-GENERATED，勿手改）
 *
 * 本测试守护两点：
 * 1. 生成物与源一致：重新生成结果与磁盘上的 _shared 文件逐字节一致
 *    （防手改生成物、防改源后漏跑脚本）——直接调用 scripts/i18n-sync.mjs --check。
 * 2. 映射运行时一致性：前端语言包（含 _shared 引用）解析出的译文 === backend 源译文，
 *    三语言逐一校验（防 manifest 登记错误、防前端手写值与源漂移）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import backendEn from '../../i18n/langs/en';
import backendJa from '../../i18n/langs/ja';
import backendZh from '../../i18n/langs/zh-CN';

import frontendEn from '../../../frontend/src/i18n/langs/en';
import frontendJa from '../../../frontend/src/i18n/langs/ja';
import frontendZh from '../../../frontend/src/i18n/langs/zh-CN';

import sharedEn from '../../../frontend/src/i18n/langs/_shared/en';
import sharedJa from '../../../frontend/src/i18n/langs/_shared/ja';
import sharedZh from '../../../frontend/src/i18n/langs/_shared/zh-CN';

type MessageTree = Record<string, unknown>;

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'i18n-shared-manifest.json');

/** 递归收集叶子 key（点分路径 -> 文案字符串），与 languageParity.test.ts 一致 */
function collectLeaves(tree: MessageTree, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
    for (const [key, value] of Object.entries(tree)) {
        const pathName = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            out.set(pathName, value);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            collectLeaves(value as MessageTree, pathName, out);
        } else {
            out.set(pathName, JSON.stringify(value));
        }
    }
    return out;
}

function resolveByPath(tree: MessageTree, dotted: string): unknown {
    let node: unknown = tree;
    for (const seg of dotted.split('.')) {
        if (node && typeof node === 'object' && seg in (node as object)) {
            node = (node as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
    }
    return node;
}

describe('i18n shared artifact parity（共享词条生成物一致性）', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const mappings: Array<{ frontend: string; backend: string }> = manifest.mappings ?? [];

    const backendLeaves = {
        'zh-CN': collectLeaves(backendZh as unknown as MessageTree),
        en: collectLeaves(backendEn as unknown as MessageTree),
        ja: collectLeaves(backendJa as unknown as MessageTree),
    };
    const frontendLeaves = {
        'zh-CN': collectLeaves(frontendZh as unknown as MessageTree),
        en: collectLeaves(frontendEn as unknown as MessageTree),
        ja: collectLeaves(frontendJa as unknown as MessageTree),
    };
    // 生成物自身（独立导入，确认结构完整）
    const sharedLeaves = {
        'zh-CN': collectLeaves(sharedZh as unknown as MessageTree),
        en: collectLeaves(sharedEn as unknown as MessageTree),
        ja: collectLeaves(sharedJa as unknown as MessageTree),
    };

    test('manifest 中的 backend key 在三份 backend 语言包中均存在', () => {
        const missing: string[] = [];
        for (const m of mappings) {
            for (const lang of ['zh-CN', 'en', 'ja'] as const) {
                if (!backendLeaves[lang].has(m.backend)) missing.push(`${m.backend} (${lang})`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('生成物 _shared 覆盖 manifest 中登记的全部 frontend key（三语言）', () => {
        const missing: string[] = [];
        for (const m of mappings) {
            for (const lang of ['zh-CN', 'en', 'ja'] as const) {
                if (!sharedLeaves[lang].has(m.frontend)) missing.push(`${m.frontend} (${lang})`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('前端语言包解析出的译文 === backend 源译文（三语言逐条比对）', () => {
        const mismatches: string[] = [];
        for (const m of mappings) {
            for (const lang of ['zh-CN', 'en', 'ja'] as const) {
                const frontendValue = frontendLeaves[lang].get(m.frontend);
                const backendValue = backendLeaves[lang].get(m.backend);
                if (frontendValue === undefined) {
                    mismatches.push(`${m.frontend} (${lang}): 前端缺少该 key`);
                } else if (frontendValue !== backendValue) {
                    mismatches.push(`${m.frontend} (${lang}): 前端 "${frontendValue}" vs 后端 "${backendValue}"`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    test('生成物与源一致（node scripts/i18n-sync.mjs --check 通过，防漂移）', () => {
        const result = spawnSync(process.execPath, [path.join('scripts', 'i18n-sync.mjs'), '--check'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 60000,
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        if (result.status !== 0) {
            throw new Error(`i18n-sync --check 失败:\n${output}`);
        }
    });

    test('生成物叶子数与 manifest 映射数一致（每语言）', () => {
        for (const lang of ['zh-CN', 'en', 'ja'] as const) {
            expect(sharedLeaves[lang].size).toBe(mappings.length);
        }
    });

    test('_shared 生成物默认导出可直接按 frontend key 路径取到字符串', () => {
        for (const m of mappings) {
            const value = resolveByPath(sharedZh as unknown as MessageTree, m.frontend);
            expect(typeof value).toBe('string');
        }
    });
});
