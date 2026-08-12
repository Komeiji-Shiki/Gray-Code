/**
 * 模型工具声明本地化测试（工具声明中英文国际化基础设施，见
 * .graycode/plans/tool-declaration-i18n/implementation-plan.md 第 10.1 节）。
 *
 * 覆盖：
 * - localizeToolDeclaration：顶层 description / 普通参数 / 数组 items 嵌套 /
 *   多层对象+数组路径（structuredFindings[].evidence[].path）的说明替换；
 *   未配置项保留原文；无效路径静默跳过；原声明无副作用（深度比较）；
 *   工具名 / type / enum / required / default 完全不变；
 *   localization 为 undefined 时零拷贝返回原对象（引用相等）；
 * - resolveLocalizationLanguage：zh-CN→zh-CN、en→en、ja→en、未知→en；
 * - getToolDescriptionLocalization：zh-CN 与 en 目录查询、未配置工具返回 undefined。
 */

import { localizeToolDeclaration } from '../../tools/localization/localizeToolDeclaration';
import { resolveLocalizationLanguage } from '../../tools/localization/types';
import { getToolDescriptionLocalization } from '../../tools/localization/catalogs';
import { zhCN } from '../../tools/localization/catalogs/zh-CN/index';
import { en as enCatalog } from '../../tools/localization/catalogs/en/index';
import type { ToolDeclaration } from '../../tools/types';

/** 带 enum/required/default 与嵌套数组 schema 的静态工具声明（apply_diff 形态） */
const APPLY_DIFF_DECLARATION: ToolDeclaration = {
    name: 'apply_diff',
    description: 'Apply structured edits to a file.',
    parameters: {
        type: 'object',
        required: ['path'],
        properties: {
            path: { type: 'string', description: 'The file path to edit.' },
            files: {
                type: 'array',
                description: 'Batch mode: the files to edit.',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path in batch mode.' }
                    }
                }
            },
            hunks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        oldContent: { type: 'string', description: 'Exact original content to match.' }
                    }
                }
            },
            mode: { type: 'string', enum: ['search', 'replace'], description: 'Operation mode.', default: 'search' }
        }
    }
};

/** 多层对象+数组路径形态（create_review 的 structuredFindings 结构） */
const REVIEW_DECLARATION: ToolDeclaration = {
    name: 'create_review',
    description: 'Create a review document.',
    parameters: {
        type: 'object',
        required: ['title'],
        properties: {
            structuredFindings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        evidence: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string', description: 'Evidence file path.' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

describe('localizeToolDeclaration 说明替换', () => {
    test('顶层 description 替换', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            description: '对文件应用结构化编辑。'
        });
        expect(result.description).toBe('对文件应用结构化编辑。');
    });

    test('普通参数 description 替换（path）', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            parameters: { path: '要编辑的文件路径。' }
        });
        expect(result.parameters.properties.path.description).toBe('要编辑的文件路径。');
    });

    test('数组 items 内嵌套说明替换（files[].path、hunks[].oldContent）', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            parameters: {
                'files[].path': '批量模式下的文件路径。',
                'hunks[].oldContent': '需要精确匹配的原文内容。'
            }
        });
        expect(result.parameters.properties.files.items.properties.path.description).toBe('批量模式下的文件路径。');
        expect(result.parameters.properties.hunks.items.properties.oldContent.description).toBe('需要精确匹配的原文内容。');
    });

    test('多层对象+数组路径替换（structuredFindings[].evidence[].path）', () => {
        const result = localizeToolDeclaration(REVIEW_DECLARATION, {
            parameters: {
                'structuredFindings[].evidence[].path': '证据文件路径。'
            }
        });
        const findings = result.parameters.properties.structuredFindings;
        expect(findings.items.properties.evidence.items.properties.path.description).toBe('证据文件路径。');
    });
});

describe('localizeToolDeclaration 保留语义', () => {
    test('未配置项保留原文：localization 缺 description 时顶层说明不变，未覆盖路径不变', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            parameters: { path: '要编辑的文件路径。' }
        });
        expect(result.description).toBe(APPLY_DIFF_DECLARATION.description);
        // 未配置的嵌套路径保留原文
        expect(result.parameters.properties.files.items.properties.path.description).toBe('File path in batch mode.');
        expect(result.parameters.properties.hunks.items.properties.oldContent.description).toBe('Exact original content to match.');
        expect(result.parameters.properties.mode.description).toBe('Operation mode.');
    });

    test('无效路径静默跳过：不抛错、不凭空创建键、不影响其他替换项', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            description: '中文顶层说明。',
            parameters: {
                'noSuchParam': '不存在的路径',
                'files[].noSuchProp': '不存在的嵌套属性',
                path: '要编辑的文件路径。'
            }
        });
        expect(result.description).toBe('中文顶层说明。');
        expect(result.parameters.properties.path.description).toBe('要编辑的文件路径。');
        // 原声明里没有的键不会被创建
        expect(result.parameters.properties.noSuchParam).toBeUndefined();
    });

    test('工具名、schema 类型、enum、required 完全不变', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            description: '对文件应用结构化编辑。',
            parameters: {
                path: '要编辑的文件路径。',
                'files[].path': '批量模式下的文件路径。',
                'hunks[].oldContent': '需要精确匹配的原文内容。'
            }
        });
        expect(result.name).toBe('apply_diff');
        expect(result.parameters.type).toBe('object');
        expect(result.parameters.required).toEqual(['path']);
        const mode = result.parameters.properties.mode;
        expect(mode.type).toBe('string');
        expect(mode.enum).toEqual(['search', 'replace']);
        expect(mode.default).toBe('search');
    });

    test('原声明对象没有被修改（深度比较前后对象）', () => {
        const snapshot = JSON.parse(JSON.stringify(APPLY_DIFF_DECLARATION));
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {
            description: '对文件应用结构化编辑。',
            parameters: {
                path: '要编辑的文件路径。',
                'files[].path': '批量模式下的文件路径。',
                'hunks[].oldContent': '需要精确匹配的原文内容。'
            }
        });
        expect(result).not.toBe(APPLY_DIFF_DECLARATION);
        expect(APPLY_DIFF_DECLARATION).toEqual(snapshot);
    });

    test('localization 为 undefined 时返回原对象（引用相等，零拷贝）', () => {
        expect(localizeToolDeclaration(APPLY_DIFF_DECLARATION, undefined)).toBe(APPLY_DIFF_DECLARATION);
    });

    test('localization 为空对象时返回克隆但内容不变', () => {
        const result = localizeToolDeclaration(APPLY_DIFF_DECLARATION, {});
        expect(result).not.toBe(APPLY_DIFF_DECLARATION);
        expect(result).toEqual(APPLY_DIFF_DECLARATION);
    });
});

describe('localizeToolDeclaration required 数组隔离', () => {
    test('返回对象的 required 数组不与原声明共享引用', () => {
        const declaration: ToolDeclaration = {
            name: 'sample_tool',
            description: 'Original description.',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string', description: 'The path.' },
                    files: { type: 'array', description: 'Files.' }
                }
            }
        };
        const result = localizeToolDeclaration(declaration, {
            description: '中文说明。',
            parameters: { path: '路径说明。' }
        });
        // 修复点：required 数组必须克隆（否则对返回对象 push 会污染原声明的 required）
        expect(result.parameters.required).not.toBe(declaration.parameters.required);
        result.parameters.required!.push('files');
        expect(result.parameters.required).toEqual(['path', 'files']);
        expect(declaration.parameters.required).toEqual(['path']);
    });
});

describe('resolveLocalizationLanguage 语言归并', () => {
    test('zh-CN → zh-CN', () => {
        expect(resolveLocalizationLanguage('zh-CN')).toBe('zh-CN');
    });

    test('en → en', () => {
        expect(resolveLocalizationLanguage('en')).toBe('en');
    });

    test('ja → en（本阶段日文暂用英文模型说明）', () => {
        expect(resolveLocalizationLanguage('ja')).toBe('en');
    });

    test('未知语言 → en（兜底）', () => {
        expect(resolveLocalizationLanguage('fr')).toBe('en');
        expect(resolveLocalizationLanguage('')).toBe('en');
    });
});

describe('getToolDescriptionLocalization 目录查找', () => {
    test('zh-CN 目录：workflow / auxiliary 分类的代表工具已配置本地化', () => {
        // 静态工具（todo_update、memory_note 等）由目录提供中文说明；
        // file/search/lsp 工具（如 write_file）由语言感知动态生成器负责，目录不配置（返回 undefined 是设计使然）。
        expect(getToolDescriptionLocalization('zh-CN', 'write_file')).toBeUndefined();
        expect(getToolDescriptionLocalization('zh-CN', 'todo_update')).toBeDefined();
        expect(getToolDescriptionLocalization('zh-CN', 'memory_note')).toBeDefined();
    });

    test('en 目录：delete_code 的 files 参数拼写修正覆盖存在', () => {
        const localization = getToolDescriptionLocalization('en', 'delete_code');
        expect(localization).toBeDefined();
        // 修正 parameterMUST 拼写：参数层必须出现 "MUST be an array" 语义
        expect(localization!.parameters?.['files']).toContain('MUST be an array');
    });

    test('en 目录 memory_note 覆盖（并行修复中）：若已合入则覆盖说明不含中文字符', () => {
        const localization = getToolDescriptionLocalization('en', 'memory_note');
        if (!localization) {
            // 并行修复（en 目录 memory_* 英文覆盖）尚未合入：en 无 memory_note，保留英文原文属预期
            expect(localization).toBeUndefined();
            return;
        }
        const texts = [localization.description, ...Object.values(localization.parameters ?? {})]
            .filter((text): text is string => typeof text === 'string');
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
            expect(text).not.toMatch(/[\u4e00-\u9fff]/);
        }
    });

    test('未配置的工具返回 undefined（两种语言一致）', () => {
        expect(getToolDescriptionLocalization('zh-CN', 'definitely_no_such_tool')).toBeUndefined();
        expect(getToolDescriptionLocalization('en', 'definitely_no_such_tool')).toBeUndefined();
    });
});

describe('目录参数路径键格式校验', () => {
    /**
     * localizeToolDeclaration.setDescriptionAtPath 的本地镜像（该实现未导出）：
     * 路径键以 '.' 分段；'[]' 结尾的段是数组遍历（取 items 后继续）；末段写入 description。
     */
    function resolvePathInSchema(properties: Record<string, any>, pathKey: string): boolean {
        const segments = pathKey.split('.');
        let node: Record<string, any> | undefined = { properties };
        for (let i = 0; i < segments.length; i++) {
            if (!node) {
                return false;
            }
            const segment = segments[i];
            const isArrayTraversal = segment.endsWith('[]');
            const name = isArrayTraversal ? segment.slice(0, -2) : segment;
            const prop = node.properties?.[name] ?? node[name];
            if (!prop || typeof prop !== 'object') {
                return false;
            }
            if (i === segments.length - 1) {
                return true;
            }
            node = isArrayTraversal ? (prop.items ?? prop) : prop;
        }
        return false;
    }

    /** 由键自身构造最小 schema fixture：每段一个对象属性；'[]' 段生成 array → items → object 结构 */
    function buildFixtureFromKey(pathKey: string): Record<string, any> {
        const segments = pathKey.split('.');
        const root: Record<string, any> = {};
        let current = root;
        for (const segment of segments) {
            const isArrayTraversal = segment.endsWith('[]');
            const name = isArrayTraversal ? segment.slice(0, -2) : segment;
            const child: Record<string, any> = { type: 'object', properties: {} };
            if (isArrayTraversal) {
                child.type = 'array';
                child.items = { type: 'object', properties: {} };
            }
            current[name] = child;
            current = isArrayTraversal ? child.items.properties : child.properties;
        }
        return root;
    }

    /** 段格式：普通名（字母/下划线开头，可含数字）或 name[] 数组段；不允许 '[]' 开头 / 连续 '[][]' */
    const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[\])?$/;

    function validateKeyFormat(key: string): string[] {
        const errors: string[] = [];
        if (key.length === 0) {
            errors.push('空键');
            return errors;
        }
        const segments = key.split('.');
        for (const segment of segments) {
            if (segment.length === 0) {
                errors.push(`段为空：${key}`);
            } else if (segment.startsWith('[]')) {
                errors.push(`段以 '[]' 开头：${key} → ${segment}`);
            } else if (segment.includes('[][]')) {
                errors.push(`段含连续 '[][]'：${key} → ${segment}`);
            } else if (!SEGMENT_RE.test(segment)) {
                errors.push(`段格式非法：${key} → ${segment}`);
            }
        }
        return errors;
    }

    test.each(['zh-CN', 'en'])('%s 目录：全部参数路径键格式合法且能被路径解析', (lang) => {
        const catalog = lang === 'zh-CN' ? zhCN : enCatalog;
        const toolNames = Object.keys(catalog);
        expect(toolNames.length).toBeGreaterThan(0);
        const errors: string[] = [];
        for (const toolName of toolNames) {
            const parameters = catalog[toolName].parameters ?? {};
            for (const key of Object.keys(parameters)) {
                errors.push(...validateKeyFormat(key).map(error => `${toolName} → ${error}`));
                // 用与 setDescriptionAtPath 相同的遍历逻辑在最小 fixture 上解析，必须能找到叶子
                if (!resolvePathInSchema(buildFixtureFromKey(key), key)) {
                    errors.push(`${toolName} → ${key}：按路径解析逻辑无法定位`);
                }
            }
        }
        expect(errors).toEqual([]);
    });
});
