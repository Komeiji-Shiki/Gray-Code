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

    test('未配置的工具返回 undefined（两种语言一致）', () => {
        expect(getToolDescriptionLocalization('zh-CN', 'definitely_no_such_tool')).toBeUndefined();
        expect(getToolDescriptionLocalization('en', 'definitely_no_such_tool')).toBeUndefined();
    });
});
