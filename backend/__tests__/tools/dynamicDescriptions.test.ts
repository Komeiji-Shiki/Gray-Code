/**
 * 动态工具说明生成器测试（模型工具声明本地化计划 §10.3；纯函数直测，不依赖 mock 环境）。
 *
 * 覆盖（backend/tools/localization/dynamicDescriptions.ts）：
 * - read_file 多模态四分支：未启用多模态 / openai+function_call 回退纯文本 /
 *   openai 其他（xml/json）仅图片 / gemini、anthropic 图片+PDF——zh/en 双语；
 * - read_file 单根 vs 多根：多根时 path / files[].path 说明列出可用工作区名称；
 * - generate_image 动态上限插值（maxBatchTasks / maxImagesPerTask）；
 * - crop_image 归一化（0-1000）与像素两套坐标说明；
 * - 图片工具批量互斥模式说明；
 * - 多根工作区尾巴：非空名称列表时列出；空列表时不输出「可用工作区」空尾巴（对齐并行修复目标行为）；
 * - 语言纯净性混排扫描：en 输出无 CJK 字符；zh 输出无白名单外的连续英文单词。
 */

import {
    buildReadFileDescriptions,
    buildGenerateImageDescriptions,
    buildRemoveBackgroundDescriptions,
    buildCropImageDescriptions,
    buildResizeImageDescriptions,
    buildRotateImageDescriptions
} from '../../tools/localization/dynamicDescriptions';
import type { LocalizationLanguage } from '../../tools/localization/types';

const LANGS: LocalizationLanguage[] = ['zh-CN', 'en'];

/** 收集某个 builder 输出的全部文本（description + 全部参数说明） */
function collectAllTexts(output: object): string[] {
    return Object.values(output).filter((value): value is string => typeof value === 'string');
}

// ==================== read_file 多模态四分支 ====================

interface ReadFileBranchCase {
    label: string;
    options: {
        multimodalEnabled?: boolean;
        channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
        toolMode?: 'function_call' | 'xml' | 'json';
    };
    expected: 'text' | 'text+image' | 'text+image+pdf';
}

const READ_FILE_BRANCHES: ReadFileBranchCase[] = [
    { label: '未启用多模态', options: { multimodalEnabled: false }, expected: 'text' },
    { label: 'openai + function_call（回退纯文本）', options: { multimodalEnabled: true, channelType: 'openai', toolMode: 'function_call' }, expected: 'text' },
    { label: 'openai + xml（仅图片）', options: { multimodalEnabled: true, channelType: 'openai', toolMode: 'xml' }, expected: 'text+image' },
    { label: 'openai + json（仅图片）', options: { multimodalEnabled: true, channelType: 'openai', toolMode: 'json' }, expected: 'text+image' },
    { label: 'gemini（图片+PDF）', options: { multimodalEnabled: true, channelType: 'gemini' }, expected: 'text+image+pdf' },
    { label: 'anthropic（图片+PDF）', options: { multimodalEnabled: true, channelType: 'anthropic' }, expected: 'text+image+pdf' }
];

/**
 * 断言 read_file 顶层说明的支持类型表述。
 * 注意：openai xml/json 分支会在说明末尾拼接「行范围只适用于文本」的二进制限制注记，
 * 其中以 PDF 作为非文本文件示例（属合法出现），因此「不含 PDF」只对支持类型首句断言。
 */
function expectSupportedTypes(description: string, lang: LocalizationLanguage, expected: 'text' | 'text+image' | 'text+image+pdf'): void {
    const firstLine = description.split('\n')[0];
    if (expected === 'text') {
        // 纯文本分支：整段说明都不应出现图片/PDF 支持字样
        if (lang === 'zh-CN') {
            expect(description).not.toMatch(/图片|PDF/);
        } else {
            expect(description).not.toMatch(/image|PDF/i);
        }
        return;
    }
    if (lang === 'zh-CN') {
        expect(description).toContain('图片');
        expect(description).toContain('PNG');
    } else {
        expect(description).toMatch(/image/i);
        expect(description).toContain('PNG');
    }
    if (expected === 'text+image') {
        // openai 其他模式仅支持图片：支持类型首句不含 PDF（文档）
        expect(firstLine).not.toContain('PDF');
    } else {
        expect(firstLine).toContain('PDF');
    }
}

describe('buildReadFileDescriptions 多模态四分支', () => {
    for (const branch of READ_FILE_BRANCHES) {
        test.each(LANGS)(`${branch.label}（%s）`, (lang) => {
            const out = buildReadFileDescriptions({
                lang,
                isMultiRoot: false,
                workspaceNames: [],
                ...branch.options
            });
            expectSupportedTypes(out.description, lang, branch.expected);
        });
    }
});

// ==================== read_file 单根 vs 多根 ====================

describe('buildReadFileDescriptions 单根 vs 多根', () => {
    test.each(LANGS)('%s：多根时 path / files[].path 说明列出可用工作区 alpha、beta', (lang) => {
        const out = buildReadFileDescriptions({
            lang,
            isMultiRoot: true,
            workspaceNames: ['alpha', 'beta'],
            multimodalEnabled: false
        });
        expect(out.path).toContain('alpha');
        expect(out.path).toContain('beta');
        expect(out.batchPath).toContain('alpha');
        expect(out.batchPath).toContain('beta');
        // 顶层说明同样携带多根格式说明
        expect(out.description).toContain('workspace_name');
    });

    test.each(LANGS)('%s：单根时不包含工作区名称与多根格式说明', (lang) => {
        const out = buildReadFileDescriptions({
            lang,
            isMultiRoot: false,
            workspaceNames: [],
            multimodalEnabled: false
        });
        expect(out.path).not.toContain('alpha');
        expect(out.batchPath).not.toContain('alpha');
        expect(out.path).not.toContain('workspace_name');
        expect(out.description).not.toContain('workspace_name');
    });
});

// ==================== generate_image 动态上限 ====================

describe('buildGenerateImageDescriptions 动态上限', () => {
    const base = {
        maxBatchTasks: 7,
        maxImagesPerTask: 2,
        config: { enableAspectRatio: false, enableImageSize: false },
        isMultiRoot: false,
        workspaceNames: [] as string[]
    };

    test.each(LANGS)('%s：description 插值 maxBatchTasks=7 与 maxImagesPerTask=2', (lang) => {
        const out = buildGenerateImageDescriptions({ ...base, lang });
        expect(out.description).toContain('7');
        expect(out.description).toContain('2');
        if (lang === 'zh-CN') {
            expect(out.description).toContain('最多 7 个生成任务');
            expect(out.description).toContain('最多保存 2 张图片');
        } else {
            expect(out.description).toContain('Maximum 7 generation tasks per call');
            expect(out.description).toContain('Maximum 2 images saved per task');
        }
    });
});

// ==================== crop_image 两套坐标 ====================

describe('buildCropImageDescriptions 两套坐标', () => {
    const base = { maxBatchTasks: 5, isMultiRoot: false, workspaceNames: [] as string[] };

    test.each(LANGS)('%s：useNormalized=true → 归一化坐标（0-1000）', (lang) => {
        const out = buildCropImageDescriptions({ ...base, lang, useNormalized: true });
        expect(out.description).toContain('0-1000');
        if (lang === 'zh-CN') {
            expect(out.description).toContain('归一化');
        } else {
            expect(out.description).toMatch(/normalized/i);
        }
        // 坐标参数说明同样切到归一化口径
        expect(out.batchX1).toContain('0-1000');
        expect(out.singleX1).toContain('0-1000');
    });

    test.each(LANGS)('%s：useNormalized=false → 像素坐标', (lang) => {
        const out = buildCropImageDescriptions({ ...base, lang, useNormalized: false });
        if (lang === 'zh-CN') {
            expect(out.description).toContain('像素');
            expect(out.description).not.toContain('归一化');
        } else {
            expect(out.description).toMatch(/pixel/i);
            expect(out.description).not.toMatch(/normalized/i);
        }
        expect(out.batchX1).toMatch(lang === 'zh-CN' ? /像素/ : /pixel/i);
    });
});

// ==================== 多根工作区尾巴 ====================

describe('多根工作区尾巴（图片工具 description）', () => {
    const base = {
        maxBatchTasks: 5,
        maxImagesPerTask: 1,
        config: { enableAspectRatio: false, enableImageSize: false }
    };

    test.each(LANGS)('%s：workspaceNames=[alpha, beta] → description 列出可用工作区', (lang) => {
        const out = buildGenerateImageDescriptions({
            ...base,
            lang,
            isMultiRoot: true,
            workspaceNames: ['alpha', 'beta']
        });
        expect(out.description).toContain('alpha');
        expect(out.description).toContain('beta');
    });

    test.each(LANGS)('%s：workspaceNames=[] → 不输出「可用工作区」空尾巴', (lang) => {
        // 对齐并行修复目标行为：工作区列表为空时不输出 "可用工作区：" / "Available workspaces:"
        // 空尾巴。当前实现 multiRootTail 仍会拼出空列表尾巴（"可用工作区：" + 空串），
        // 修复合入后本用例转绿；若长期失败说明修复未合入或行为未收敛——这正是要盯住的缺口。
        const out = buildGenerateImageDescriptions({
            ...base,
            lang,
            isMultiRoot: true,
            workspaceNames: []
        });
        expect(out.description).not.toContain('可用工作区');
        expect(out.description).not.toContain('Available workspaces');
    });
});

// ==================== 图片工具批量互斥说明 ====================

describe('图片工具批量互斥说明', () => {
    test.each(LANGS)('%s：generate_image 说明包含互斥模式语义', (lang) => {
        const out = buildGenerateImageDescriptions({
            lang,
            maxBatchTasks: 5,
            maxImagesPerTask: 1,
            config: { enableAspectRatio: false, enableImageSize: false },
            isMultiRoot: false,
            workspaceNames: []
        });
        if (lang === 'zh-CN') {
            expect(out.description).toContain('互斥');
        } else {
            expect(out.description).toMatch(/mutually exclusive/i);
        }
    });
});

// ==================== 语言纯净性（混排扫描） ====================

/**
 * zh 输出中允许出现的英文单词（小写）。全部为有意保留的专有名词 / 标识符：
 * - 工具与参数标识符：get_symbols / goto_definition / find_references / list_files /
 *   find_files、read_file 行号参数 startLine/endLine（1-based）、workspace_name、
 *   path/files/images/prompt/output 等 schema 键、图片工具参数名
 *   （image_path、aspect_ratio、image_size、subject_description、width/height/angle/format…）；
 * - 图片格式专有名词：PNG / JPEG / WebP / PDF；模型/厂商名：OpenAI / Gemini / Anthropic / API；
 * - generate_image 中文说明里故意保留的英文标签式提示词示例
 *   （orange cat, sitting on windowsill, sunlight, warm lighting, high quality）。
 * 白名单外出现 ≥5 个连续 ASCII 字母，说明有整段英文漏本地化——测试应失败。
 */
const ZH_ALLOWED_EN_WORDS = new Set([
    'startline', 'endline', 'based', 'symbols', 'definition', 'references', 'files',
    'workspace', 'images', 'prompt', 'output', 'remove', 'background', 'aspect', 'ratio',
    'image', 'subject', 'description', 'width', 'height', 'angle', 'format',
    'orange', 'sitting', 'windowsill', 'sunlight', 'lighting', 'quality',
    'openai', 'gemini', 'anthropic', 'api', 'pdf', 'png', 'jpeg', 'webp'
]);

/** 返回文本中白名单外的连续英文单词（≥5 个 ASCII 字母），去重 */
function findUnexpectedEnglishWords(text: string): string[] {
    const matches = text.match(/[A-Za-z]{5,}/g) ?? [];
    const unexpected = matches.filter(word => !ZH_ALLOWED_EN_WORDS.has(word.toLowerCase()));
    return [...new Set(unexpected)];
}

describe('语言纯净性（混排扫描）', () => {
    const CJK_RE = /[\u4e00-\u9fff]/;

    /** 用代表性选项构建全部 6 个 builder 的输出文本（description + 全部参数说明） */
    function buildAllTexts(lang: LocalizationLanguage): string[] {
        const outputs = [
            buildReadFileDescriptions({ lang, multimodalEnabled: true, channelType: 'gemini', isMultiRoot: false, workspaceNames: [] }),
            buildGenerateImageDescriptions({
                lang,
                maxBatchTasks: 7,
                maxImagesPerTask: 2,
                config: { enableAspectRatio: true, enableImageSize: true },
                isMultiRoot: false,
                workspaceNames: []
            }),
            buildRemoveBackgroundDescriptions({ lang, maxBatchTasks: 5, isMultiRoot: false, workspaceNames: [] }),
            buildCropImageDescriptions({ lang, maxBatchTasks: 5, isMultiRoot: false, workspaceNames: [], useNormalized: true }),
            buildResizeImageDescriptions({ lang, maxBatchTasks: 5, isMultiRoot: false, workspaceNames: [] }),
            buildRotateImageDescriptions({ lang, maxBatchTasks: 5, isMultiRoot: false, workspaceNames: [] })
        ];
        return outputs.flatMap(collectAllTexts);
    }

    test('en：全部输出（description + 参数说明）不含 CJK 字符', () => {
        const texts = buildAllTexts('en');
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
            expect(text).not.toMatch(CJK_RE);
        }
    });

    test('zh：输出不含白名单外的连续英文单词（≥5 个 ASCII 字母）', () => {
        const texts = buildAllTexts('zh-CN');
        expect(texts.length).toBeGreaterThan(0);
        const unexpected = findUnexpectedEnglishWords(texts.join('\n'));
        expect(unexpected).toEqual([]);
    });
});
