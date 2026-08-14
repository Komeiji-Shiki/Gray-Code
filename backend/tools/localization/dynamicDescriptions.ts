/**
 * GrayCode - 动态工具说明的语言感知生成器
 *
 * 职责：
 * - 为 read_file 与 5 个图片工具（generate_image / remove_background / crop_image /
 *   resize_image / rotate_image）生成语言感知的模型可见说明（zh-CN 中文 / en 英文）。
 * - 这些工具的顶层说明依赖运行时信息（多模态能力、渠道类型、工具模式、动态任务上限、
 *   宽高比/尺寸参数开关、多根工作区名称等），不能由静态本地化目录覆盖；
 *   目录（catalogs）只负责参数说明，本模块负责动态工具的顶层说明与动态参数说明。
 * - 语言选择由调用方（各工具工厂）通过 getActualLanguage() + resolveLocalizationLanguage()
 *   完成，本模块函数接收 LocalizationLanguage，保持纯函数、便于测试。
 * - ja 由 resolveLocalizationLanguage 映射到 en（本阶段日文暂用英文模型说明）。
 *
 * 本模块只输出 description 文本，不涉及工具名、参数键、type、enum、required、
 * default、strict、readOnly 等 schema 字段。
 */

import type { LocalizationLanguage } from './types';

/** 按语言选择文本 */
function pick(lang: LocalizationLanguage, zhText: string, enText: string): string {
    return lang === 'zh-CN' ? zhText : enText;
}

// ==================== 通用说明片段 ====================

/** read_file：path 与 files 互斥模式说明 */
const READ_FILE_MODE_NOTE_ZH =
    '\n\npath 与 files 是单文件和批量两种互斥模式：path 为单文件模式，files 为批量模式，必须选择其中一种，不要同时发送。';
const READ_FILE_MODE_NOTE_EN =
    '\n\npath and files are two mutually exclusive modes: path is single-file mode, files is batch mode. Choose exactly one; do not send both.';

/** 图片工具：单任务参数与 images 批量数组互斥模式说明 */
const MEDIA_MODE_NOTE_ZH =
    '\n\n单任务参数与 images 批量数组是两种互斥模式，应选择其中一种，不要同时发送。';
const MEDIA_MODE_NOTE_EN =
    '\n\nSingle-task parameters and the images batch array are two mutually exclusive modes; choose one and do not send both.';

/** 多根工作区尾巴（可用工作区名称保留运行时插值） */
function multiRootTail(lang: LocalizationLanguage, workspaceNames: string[]): string {
    // workspaceNames 为空时省略工作区列表，避免输出 "可用工作区：" 空尾巴；保留多根提示本身。
    if (workspaceNames.length === 0) {
        return pick(
            lang,
            '\n\n**多根工作区**：路径必须使用 "workspace_name/path" 格式。',
            '\n\n**Multi-root Workspace**: Paths must use "workspace_name/path" format.'
        );
    }
    return pick(
        lang,
        `\n\n**多根工作区**：路径必须使用 "workspace_name/path" 格式。可用工作区：${workspaceNames.join(', ')}`,
        `\n\n**Multi-root Workspace**: Paths must use "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}`
    );
}

// ==================== read_file ====================

export interface ReadFileDescriptionOptions {
    lang: LocalizationLanguage;
    /** 是否启用多模态工具 */
    multimodalEnabled?: boolean;
    /** 渠道类型 */
    channelType?: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    /** 工具模式 */
    toolMode?: 'function_call' | 'xml' | 'json';
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
}

export interface ReadFileDescriptions {
    /** 顶层说明 */
    description: string;
    /** path 参数说明 */
    path: string;
    /** files[].path 参数说明 */
    batchPath: string;
    /** files 数组参数说明 */
    files: string;
    /** 顶层 startLine 参数说明 */
    startLine: string;
    /** 顶层 endLine 参数说明 */
    endLine: string;
    /** files[].startLine 参数说明 */
    batchStartLine: string;
    /** files[].endLine 参数说明 */
    batchEndLine: string;
}

/**
 * 生成 read_file 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 顶层说明按多模态能力分支：
 * - 未启用多模态 / OpenAI function_call 回退：纯文本；
 * - OpenAI 其他模式（xml/json）：文本 + 图片（PNG/JPEG/WebP）；
 * - Gemini / Anthropic：文本 + 图片 + 文档（PDF）。
 *
 * 中英文都明确：path 与 files 互斥、顶层 startLine/endLine 只属于单文件模式、
 * files[].startLine/endLine 属于批量模式、行范围只适用于文本、行号前缀不是正文。
 */
export function buildReadFileDescriptions(options: ReadFileDescriptionOptions): ReadFileDescriptions {
    const { lang, isMultiRoot, workspaceNames } = options;

    // 行号格式说明
    const lineNumberNote = pick(
        lang,
        '\n\n说明：读取文本文件时，返回内容会带行号前缀（例如 "   1 | code here"）。这些数字和 "|" 只是定位标记，不属于文件正文；编辑文件时不要把它们写回去。',
        '\n\nNote: When reading text files, the returned content includes line number prefixes (e.g. "   1 | code here"). These numbers and the "|" are locator markers, not part of the file content; do not write them back when editing files.'
    );

    // 行范围说明。
    // 单文件兼容别名（line/maxLine/maxLines/limit）不再写进描述和 schema 向模型宣传：
    // 每轮请求都会携带工具声明，别名参数既烧 token 又鼓励旧写法。
    // 它们仍通过 declaration 的 paramAliases/compatParams 被接受（见 read_file.ts 声明）。
    const lineRangeNote = pick(
        lang,
        '\n\n行范围：单文件读取时使用顶层 startLine/endLine；批量读取时在每个 files[] 项中分别设置 startLine/endLine。只有已经知道准确行号时才填写（例如来自 get_symbols、goto_definition、find_references、list_files、find_files 或之前 read_file 的结果）。不要猜行号；不确定时不要填写行范围，先读取完整文件或使用搜索工具定位。',
        '\n\nLine ranges: in single-file mode use the top-level startLine/endLine; in batch mode set startLine/endLine on each files[] item. Only fill in line ranges when you already know the exact line numbers (e.g. from get_symbols, goto_definition, find_references, list_files, find_files, or a previous read_file result). Do not guess line numbers; when unsure, omit the line range and read the whole file or use a search tool to locate the content.'
    );

    // 多模态/二进制行范围限制说明（多模态开启时强调）
    const lineRangeBinaryRestrictionNote = pick(
        lang,
        '\n\n重要：startLine/endLine 只适用于文本文件。读取图片、PDF、音频、视频或其他二进制/多模态文件时无需填写行范围；即使误填，工具也会忽略这些行范围参数。',
        '\n\nImportant: startLine/endLine only apply to text files. Do not fill in line ranges when reading images, PDFs, audio, video, or other binary/multimodal files; even if mistakenly provided, the tool ignores them.'
    );

    const modeNote = pick(lang, READ_FILE_MODE_NOTE_ZH, READ_FILE_MODE_NOTE_EN);
    let description: string;

    if (!options.multimodalEnabled) {
        // 未启用多模态时，只支持文本文件
        description = pick(
            lang,
            '读取工作区中的一个或多个文件。当前支持类型：文本文件。',
            'Read one or more files from the workspace. Currently supported types: text files.'
        ) + modeNote + lineNumberNote + lineRangeNote;
    } else if (options.channelType === 'openai') {
        // OpenAI 格式有特殊限制
        if (options.toolMode === 'function_call') {
            // OpenAI function_call 模式不支持多模态
            description = pick(
                lang,
                '读取工作区中的一个或多个文件。当前支持类型：文本文件。',
                'Read one or more files from the workspace. Currently supported types: text files.'
            ) + modeNote + lineNumberNote + lineRangeNote;
        } else {
            // OpenAI xml/json 模式只支持图片
            description = pick(
                lang,
                '读取工作区中的一个或多个文件。当前支持类型：文本文件、图片（PNG/JPEG/WebP）。图片会作为多模态数据返回。',
                'Read one or more files from the workspace. Currently supported types: text files and images (PNG/JPEG/WebP). Images are returned as multimodal data.'
            ) + modeNote + lineNumberNote + lineRangeNote + lineRangeBinaryRestrictionNote;
        }
    } else {
        // Gemini 和 Anthropic 全面支持
        description = pick(
            lang,
            '读取工作区中的一个或多个文件。当前支持类型：文本文件、图片（PNG/JPEG/WebP）、文档（PDF）。图片和文档会作为多模态数据返回。',
            'Read one or more files from the workspace. Currently supported types: text files, images (PNG/JPEG/WebP), and documents (PDF). Images and documents are returned as multimodal data.'
        ) + modeNote + lineNumberNote + lineRangeNote + lineRangeBinaryRestrictionNote;
    }

    // 多工作区说明（保持原语义：path 与 files[].path 必须带工作区前缀）
    if (isMultiRoot) {
        description += pick(
            lang,
            '\n\n多根工作区：path 与 files[].path 必须使用 "workspace_name/path" 格式来指定工作区。',
            '\n\nMulti-root workspace: path and files[].path must use the "workspace_name/path" format to specify the workspace.'
        );
    }

    // 路径参数描述（多根时列出可用工作区名称，动态部分保留）
    const path = isMultiRoot
        ? pick(
            lang,
            `单文件读取时使用。当前是多根工作区，必须使用 "workspace_name/path" 格式。可用工作区：${workspaceNames.join(', ')}。`,
            `Use for single-file reads. This is a multi-root workspace: paths must use the "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}.`
        )
        : pick(
            lang,
            '单文件读取时使用。要读取的文件路径，相对于当前工作区根目录。例如：src/main.ts。',
            'Use for single-file reads. The file path to read, relative to the current workspace root. E.g.: src/main.ts.'
        );

    const batchPath = isMultiRoot
        ? pick(
            lang,
            `批量读取的文件路径。必须使用 "workspace_name/path" 格式。可用工作区：${workspaceNames.join(', ')}。`,
            `File path for batch reads. Must use the "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}.`
        )
        : pick(
            lang,
            '批量读取的文件路径，相对于当前工作区根目录。例如：src/main.ts。',
            'File path for batch reads, relative to the current workspace root. E.g.: src/main.ts.'
        );

    return {
        description,
        path,
        batchPath,
        files: pick(
            lang,
            '批量读取时使用。每个文件可以分别指定文本行范围；不要与顶层 path/startLine/endLine 同时使用。',
            'Use for batch reads. Each file can specify its own text line range; do not use together with the top-level path/startLine/endLine.'
        ),
        startLine: pick(
            lang,
            '起始行号，1-based，包含该行。仅文本文件可用。读取图片/PDF 等非文本文件时会被忽略。指定后从该行读取到文件末尾，或读取到 endLine。',
            'Start line number, 1-based, inclusive. Text files only; ignored when reading non-text files such as images/PDFs. When specified, reads from this line to the end of the file, or up to endLine.'
        ),
        endLine: pick(
            lang,
            '结束行号，1-based，包含该行。仅文本文件可用。读取图片/PDF 等非文本文件时会被忽略。未指定 startLine 时，从文件开头读取到该行。',
            'End line number, 1-based, inclusive. Text files only; ignored when reading non-text files such as images/PDFs. When startLine is not specified, reads from the beginning of the file up to this line.'
        ),
        batchStartLine: pick(
            lang,
            '该文本文件的起始行号，1-based，包含该行。非文本文件会忽略。',
            'Start line number of this text file, 1-based, inclusive. Ignored for non-text files.'
        ),
        batchEndLine: pick(
            lang,
            '该文本文件的结束行号，1-based，包含该行。非文本文件会忽略。',
            'End line number of this text file, 1-based, inclusive. Ignored for non-text files.'
        )
    };
}

// ==================== generate_image ====================

/** 与 generate_image.ts 的 ToolParamsConfig 形状一致（该接口未导出，这里声明结构类型） */
export interface GenerateImageParamsConfig {
    /** 是否启用宽高比参数 */
    enableAspectRatio: boolean;
    /** 强制宽高比（如果设置，AI 不能更改） */
    forcedAspectRatio?: string;
    /** 是否启用图片尺寸参数 */
    enableImageSize: boolean;
    /** 强制图片尺寸（如果设置，AI 不能更改） */
    forcedImageSize?: string;
}

export interface GenerateImageDescriptionOptions {
    lang: LocalizationLanguage;
    /** 单次调用允许的最大任务数 */
    maxBatchTasks: number;
    /** 单个任务的最大图片数 */
    maxImagesPerTask: number;
    /** 宽高比 / 图片尺寸参数配置 */
    config: GenerateImageParamsConfig;
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
}

export interface GenerateImageDescriptions {
    /** 顶层说明 */
    description: string;
    /** images 批量数组参数说明 */
    images: string;
    /** 批量任务 prompt 参数说明 */
    batchPrompt: string;
    /** 批量任务 reference_images 参数说明 */
    batchReferenceImages: string;
    /** 批量任务 output_path 参数说明 */
    batchOutputPath: string;
    /** 批量任务 aspect_ratio 参数说明（仅启用且未强制时使用） */
    batchAspectRatio: string;
    /** 批量任务 image_size 参数说明（仅启用且未强制时使用） */
    batchImageSize: string;
    /** 单张模式 prompt 参数说明 */
    singlePrompt: string;
    /** 单张模式 reference_images 参数说明 */
    singleReferenceImages: string;
    /** 单张模式 reference_images 数组项说明 */
    singleReferenceImageItem: string;
    /** 单张模式 output_path 参数说明 */
    singleOutputPath: string;
    /** 单张模式 aspect_ratio 参数说明（仅启用且未强制时使用） */
    singleAspectRatio: string;
    /** 单张模式 image_size 参数说明（仅启用且未强制时使用） */
    singleImageSize: string;
}

/**
 * 生成 generate_image 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 保留动态信息：maxBatchTasks / maxImagesPerTask、宽高比/尺寸参数开关
 * （enableAspectRatio / forcedAspectRatio / enableImageSize / forcedImageSize）、
 * 多根工作区可用名称。
 *
 * 中英文都明确：单任务参数（prompt + output_path）与 images 批量数组是两种互斥模式。
 */
export function buildGenerateImageDescriptions(options: GenerateImageDescriptionOptions): GenerateImageDescriptions {
    const { lang, maxBatchTasks, maxImagesPerTask, config, isMultiRoot, workspaceNames } = options;

    // 宽高比 / 图片尺寸参数配置说明（动态强制值保留运行时插值）
    const paramNotes: string[] = [];
    if (config.enableAspectRatio) {
        if (config.forcedAspectRatio) {
            paramNotes.push(pick(
                lang,
                `- **宽高比**：用户设置为 ${config.forcedAspectRatio}（不可更改）`,
                `- **Aspect Ratio**: User set to ${config.forcedAspectRatio} (cannot be changed)`
            ));
        } else {
            paramNotes.push(pick(
                lang,
                '- **宽高比**：可使用 aspect_ratio 参数（可选）',
                '- **Aspect Ratio**: Can use aspect_ratio parameter (optional)'
            ));
        }
    }
    if (config.enableImageSize) {
        if (config.forcedImageSize) {
            paramNotes.push(pick(
                lang,
                `- **图片尺寸**：用户设置为 ${config.forcedImageSize}（不可更改）`,
                `- **Image Size**: User set to ${config.forcedImageSize} (cannot be changed)`
            ));
        } else {
            paramNotes.push(pick(
                lang,
                '- **图片尺寸**：可使用 image_size 参数（可选）',
                '- **Image Size**: Can use image_size parameter (optional)'
            ));
        }
    }

    const paramSection = paramNotes.length > 0
        ? pick(lang, '\n\n**参数配置**：\n', '\n\n**Parameter Configuration**:\n') + paramNotes.join('\n')
        : '';

    // 顶层说明
    let description: string;
    if (lang === 'zh-CN') {
        description = `使用 AI 模型生成图片。支持单张生成与批量生成两种模式。

**重要**：生成的图片带有纯色背景，不是透明背景。如果需要透明背景图片，请生成后使用 remove_background 工具。

**限制**：
- 单次调用最多 ${maxBatchTasks} 个生成任务
- 每个任务最多保存 ${maxImagesPerTask} 张图片${paramSection}

**单张模式**：使用 prompt + output_path 参数
**批量模式**：使用 images 数组参数（最多 ${maxBatchTasks} 个任务），用不同提示词批量生成多张图片${MEDIA_MODE_NOTE_ZH}

**提示词格式**：
- 自然语言：用完整句子描述场景（例如："一只橙色的猫坐在窗台上，阳光洒在它身上"）
- 标签式：逗号分隔的关键词（例如："orange cat, sitting on windowsill, sunlight, warm lighting, high quality"）
- 混合式：两种风格结合

功能：
- 文生图：根据提示词生成图片
- 图片编辑：基于参考图片进行修改
- 多图合成：使用多张参考图片创作新场景
- 批量生成：一次请求生成多张不同的图片

生成的图片会保存到指定路径并返回供查看。`;
    } else {
        description = `Generate images using AI model. Supports single and batch generation modes.

**Important**: Generated images have solid backgrounds, NOT transparent backgrounds. If you need transparent background images, use the remove_background tool after generation.

**Limits**:
- Maximum ${maxBatchTasks} generation tasks per call
- Maximum ${maxImagesPerTask} images saved per task${paramSection}

**Single Mode**: Use prompt + output_path parameters
**Batch Mode**: Use images array parameter (max ${maxBatchTasks} tasks), generate multiple images with different prompts${MEDIA_MODE_NOTE_EN}

**Prompt Format**:
- Natural language: Describe the scene in complete sentences (e.g., "an orange cat sitting on a windowsill, sunlight shining on it")
- Tag-style: Comma-separated keywords (e.g., "orange cat, sitting on windowsill, sunlight, warm lighting, high quality")
- Mixed: Combine both styles

Features:
- Text-to-image: Generate images from prompts
- Image editing: Modify based on reference images
- Multi-image composition: Create new scenes using multiple reference images
- Batch generation: Generate multiple different images in one request

Generated images will be saved to the specified path and returned for viewing.`;
    }

    // 多工作区说明
    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    return {
        description,
        images: pick(
            lang,
            '批量模式：图片生成任务数组。每个任务可独立配置提示词、参考图片和输出路径。即使是单个任务也必须传数组，例如：[{"prompt": "...", "output_path": "..."}]',
            'Batch mode: Image generation task array. Each task can independently configure prompt, reference images, and output path. MUST be an array even for single task, e.g., [{"prompt": "...", "output_path": "..."}]'
        ),
        batchPrompt: pick(
            lang,
            '图片生成提示词。支持自然语言、标签或混合方式。',
            'Image generation prompt. Supports natural language, tags, or mixed.'
        ),
        batchReferenceImages: pick(
            lang,
            '参考图片路径数组（可选）。最多 14 张。即使是单张图片也必须传数组，例如：["image.png"]',
            'Reference image paths array (optional). Maximum 14 images. MUST be an array even for single image, e.g., ["image.png"]'
        ),
        batchOutputPath: pick(
            lang,
            '输出文件路径（必填）',
            'Output file path (required)'
        ),
        batchAspectRatio: pick(
            lang,
            '图片宽高比（可选）。支持：1:1、3:2、2:3、3:4、4:3、4:5、5:4、9:16、16:9、21:9',
            'Image aspect ratio (optional). Supported: 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9'
        ),
        batchImageSize: pick(
            lang,
            '图片分辨率（可选）。1K=1024px，2K=2048px，4K=4096px。',
            'Image resolution (optional). 1K=1024px, 2K=2048px, 4K=4096px.'
        ),
        singlePrompt: pick(
            lang,
            '单张模式：图片生成提示词。支持：1) 自然语言描述；2) 逗号分隔的标签/关键词；3) 混合风格。',
            'Single mode: Image generation prompt. Supports: 1) Natural language description; 2) Comma-separated tags/keywords; 3) Mixed style.'
        ),
        singleReferenceImages: isMultiRoot
            ? pick(
                lang,
                '单张模式：参考图片路径数组（可选）。最多 14 张。必须使用 "workspace_name/path" 格式。即使是单张图片也必须传数组。',
                'Single mode: Reference image paths array (optional). Maximum 14 images. Use "workspace_name/path" format. MUST be an array even for single image.'
            )
            : pick(
                lang,
                '单张模式：参考图片路径数组（可选）。最多 14 张。即使是单张图片也必须传数组，例如：["image.png"]',
                'Single mode: Reference image paths array (optional). Maximum 14 images. MUST be an array even for single image, e.g., ["image.png"]'
            ),
        singleReferenceImageItem: isMultiRoot
            ? pick(
                lang,
                '参考图片文件路径，使用 "workspace_name/path" 格式',
                'Reference image file path, use "workspace_name/path" format'
            )
            : pick(
                lang,
                '参考图片文件路径（相对于工作区）',
                'Reference image file path (relative to workspace)'
            ),
        singleOutputPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：输出文件路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Output file path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：输出文件路径（必填）。相对于工作区目录。',
                'Single mode: Output file path (required). Relative to workspace directory.'
            ),
        singleAspectRatio: pick(
            lang,
            '单张模式：图片宽高比（可选）。支持：1:1、3:2、2:3、3:4、4:3、4:5、5:4、9:16、16:9、21:9',
            'Single mode: Image aspect ratio (optional). Supported: 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9'
        ),
        singleImageSize: pick(
            lang,
            '单张模式：图片分辨率（可选）。1K=1024px，2K=2048px，4K=4096px。',
            'Single mode: Image resolution (optional). 1K=1024px, 2K=2048px, 4K=4096px.'
        )
    };
}

// ==================== remove_background ====================

export interface RemoveBackgroundDescriptionOptions {
    lang: LocalizationLanguage;
    /** 单次调用允许的最大任务数 */
    maxBatchTasks: number;
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
}

export interface RemoveBackgroundDescriptions {
    /** 顶层说明 */
    description: string;
    /** images 批量数组参数说明 */
    images: string;
    /** 批量任务 image_path 参数说明 */
    batchImagePath: string;
    /** 批量任务 output_path 参数说明 */
    batchOutputPath: string;
    /** 批量任务 subject_description 参数说明 */
    batchSubjectDescription: string;
    /** 批量任务 mask_path 参数说明 */
    batchMaskPath: string;
    /** 单张模式 image_path 参数说明 */
    singleImagePath: string;
    /** 单张模式 output_path 参数说明 */
    singleOutputPath: string;
    /** 单张模式 subject_description 参数说明 */
    singleSubjectDescription: string;
    /** 单张模式 mask_path 参数说明 */
    singleMaskPath: string;
}

/**
 * 生成 remove_background 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 保留动态信息：maxBatchTasks、多根工作区可用名称。
 * 中英文都明确：单任务参数与 images 批量数组是两种互斥模式。
 */
export function buildRemoveBackgroundDescriptions(options: RemoveBackgroundDescriptionOptions): RemoveBackgroundDescriptions {
    const { lang, maxBatchTasks, isMultiRoot, workspaceNames } = options;

    let description: string;
    if (lang === 'zh-CN') {
        description = `移除图片背景，生成透明 PNG。支持单张和批量两种模式。

**限制**：
- 单次调用最多 ${maxBatchTasks} 个抠图任务

**单张模式**：使用 image_path + output_path 参数
**批量模式**：使用 images 数组参数（最多 ${maxBatchTasks} 个任务）${MEDIA_MODE_NOTE_ZH}

**工作原理**：
1. 使用 AI 生成遮罩（主体=黑色，背景=白色）
2. 根据遮罩将背景设为透明
3. 保存为透明 PNG

**适用场景**：
- 商品图背景移除
- 人像抠图
- 物体提取
- 创意合成素材准备`;
    } else {
        description = `Remove background from images, generating transparent PNG. Supports single and batch modes.

**Limits**:
- Maximum ${maxBatchTasks} background removal tasks per call

**Single Mode**: Use image_path + output_path parameters
**Batch Mode**: Use images array parameter (max ${maxBatchTasks} tasks)${MEDIA_MODE_NOTE_EN}

**How it works**:
1. Uses AI to generate a mask (subject=black, background=white)
2. Sets background to transparent based on the mask
3. Saves as transparent PNG

**Use cases**:
- Product image background removal
- Portrait cutout
- Object extraction
- Creative composite material preparation`;
    }

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    return {
        description,
        images: pick(
            lang,
            '批量模式：抠图任务数组。每个任务可独立配置输入、输出和主体描述。即使是单个任务也必须传数组。',
            'Batch mode: Background removal task array. Each task can independently configure input, output, and subject description. MUST be an array even for single task.'
        ),
        batchImagePath: pick(
            lang,
            '源图片路径（必填）',
            'Source image path (required)'
        ),
        batchOutputPath: pick(
            lang,
            '输出文件路径（必填）。建议使用 .png 扩展名。',
            'Output file path (required). Recommend using .png extension.'
        ),
        batchSubjectDescription: pick(
            lang,
            '主体描述（可选）。帮助 AI 更准确地识别要保留的主体。',
            'Subject description (optional). Helps AI identify the subject to keep more accurately.'
        ),
        batchMaskPath: pick(
            lang,
            '遮罩图保存路径（可选）。提供时会额外保存遮罩图。',
            'Mask image save path (optional). If provided, also saves the mask image.'
        ),
        singleImagePath: isMultiRoot
            ? pick(
                lang,
                '单张模式：源图片路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Source image path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：源图片路径（必填）。相对于工作区。',
                'Single mode: Source image path (required). Relative to workspace.'
            ),
        singleOutputPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：输出文件路径（必填）。建议使用 .png 扩展名。必须使用 "workspace_name/path" 格式。',
                'Single mode: Output file path (required). Recommend using .png extension. Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：输出文件路径（必填）。建议使用 .png 扩展名。',
                'Single mode: Output file path (required). Recommend using .png extension.'
            ),
        singleSubjectDescription: pick(
            lang,
            '单张模式：主体描述（可选）。帮助 AI 更准确地识别要保留的主体。例如："人"、"商品"、"猫"。',
            'Single mode: Subject description (optional). Helps AI identify the subject to keep more accurately. E.g., "person", "product", "cat".'
        ),
        singleMaskPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：遮罩图保存路径（可选）。提供时会额外保存遮罩图。必须使用 "workspace_name/path" 格式。',
                'Single mode: Mask image save path (optional). If provided, also saves the mask image. Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：遮罩图保存路径（可选）。提供时会额外保存遮罩图。',
                'Single mode: Mask image save path (optional). If provided, also saves the mask image.'
            )
    };
}

// ==================== crop_image ====================

export interface CropImageDescriptionOptions {
    lang: LocalizationLanguage;
    /** 单次调用允许的最大任务数 */
    maxBatchTasks: number;
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
    /** true: 0-1000 归一化坐标；false: 像素坐标 */
    useNormalized: boolean;
}

export interface CropImageDescriptions {
    /** 顶层说明 */
    description: string;
    /** images 批量数组参数说明 */
    images: string;
    /** 批量任务 image_path 参数说明 */
    batchImagePath: string;
    /** 批量任务 output_path 参数说明 */
    batchOutputPath: string;
    /** 批量任务 x1 参数说明 */
    batchX1: string;
    /** 批量任务 y1 参数说明 */
    batchY1: string;
    /** 批量任务 x2 参数说明 */
    batchX2: string;
    /** 批量任务 y2 参数说明 */
    batchY2: string;
    /** 单张模式 image_path 参数说明 */
    singleImagePath: string;
    /** 单张模式 output_path 参数说明 */
    singleOutputPath: string;
    /** 单张模式 x1 参数说明 */
    singleX1: string;
    /** 单张模式 y1 参数说明 */
    singleY1: string;
    /** 单张模式 x2 参数说明 */
    singleX2: string;
    /** 单张模式 y2 参数说明 */
    singleY2: string;
}

/**
 * 生成 crop_image 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 归一化坐标（0-1000）与像素坐标两套说明由 useNormalized 决定，中英双语；
 * 保留动态信息：maxBatchTasks、多根工作区可用名称。
 * 中英文都明确：单任务参数与 images 批量数组是两种互斥模式。
 */
export function buildCropImageDescriptions(options: CropImageDescriptionOptions): CropImageDescriptions {
    const { lang, maxBatchTasks, isMultiRoot, workspaceNames, useNormalized } = options;

    let description: string;
    if (useNormalized) {
        description = pick(
            lang,
            `裁切图片工具。使用归一化坐标（0-1000）指定裁切区域。

**坐标系（归一化模式）**：
- 使用 0-1000 范围内的归一化坐标
- (0, 0) 表示左上角
- (1000, 1000) 表示右下角
- 工具会自动转换为实际像素坐标

**参数**：
- x1, y1：裁切区域左上角坐标（0-1000）
- x2, y2：裁切区域右下角坐标（0-1000）
- x1 必须小于 x2，y1 必须小于 y2

**示例**：
- 裁切左上四分之一：x1=0, y1=0, x2=500, y2=500
- 裁切中心区域：x1=250, y1=250, x2=750, y2=750
- 裁切右下区域：x1=500, y1=500, x2=1000, y2=1000

**支持格式**：PNG、JPEG、WebP（根据输出路径扩展名自动选择）

**限制**：
- 单次调用最多 ${maxBatchTasks} 个裁切任务${MEDIA_MODE_NOTE_ZH}`,
            `Crop image tool. Uses normalized coordinates (0-1000) to specify the crop region.

**Coordinate System (Normalized Mode)**:
- Uses normalized coordinates in range 0-1000
- (0, 0) represents top-left corner
- (1000, 1000) represents bottom-right corner
- Tool automatically converts to actual pixel coordinates

**Parameters**:
- x1, y1: Top-left corner coordinates of crop region (0-1000)
- x2, y2: Bottom-right corner coordinates of crop region (0-1000)
- x1 must be less than x2, y1 must be less than y2

**Examples**:
- Crop top-left quarter: x1=0, y1=0, x2=500, y2=500
- Crop center region: x1=250, y1=250, x2=750, y2=750
- Crop bottom-right: x1=500, y1=500, x2=1000, y2=1000

**Supported Formats**: PNG, JPEG, WebP (auto-selected based on output path extension)

**Limits**:
- Maximum ${maxBatchTasks} crop tasks per call${MEDIA_MODE_NOTE_EN}`
        );
    } else {
        description = pick(
            lang,
            `裁切图片工具。使用像素坐标指定裁切区域。

**坐标系（像素模式）**：
- 使用图片的实际像素坐标
- (0, 0) 表示左上角
- 坐标单位为像素
- 需要根据图片实际尺寸计算坐标

**参数**：
- x1, y1：裁切区域左上角坐标（像素）
- x2, y2：裁切区域右下角坐标（像素）
- x1 必须小于 x2，y1 必须小于 y2

**示例**（假设 1920x1080 图片）：
- 裁切左上四分之一：x1=0, y1=0, x2=960, y2=540
- 裁切中心区域：x1=480, y1=270, x2=1440, y2=810
- 裁切右下区域：x1=960, y1=540, x2=1920, y2=1080

**支持格式**：PNG、JPEG、WebP（根据输出路径扩展名自动选择）

**限制**：
- 单次调用最多 ${maxBatchTasks} 个裁切任务${MEDIA_MODE_NOTE_ZH}`,
            `Crop image tool. Uses pixel coordinates to specify the crop region.

**Coordinate System (Pixel Mode)**:
- Uses actual pixel coordinates of the image
- (0, 0) represents top-left corner
- Coordinates are in pixels
- Need to calculate coordinates based on actual image dimensions

**Parameters**:
- x1, y1: Top-left corner coordinates (pixels)
- x2, y2: Bottom-right corner coordinates (pixels)
- x1 must be less than x2, y1 must be less than y2

**Examples** (assuming 1920x1080 image):
- Crop top-left quarter: x1=0, y1=0, x2=960, y2=540
- Crop center region: x1=480, y1=270, x2=1440, y2=810
- Crop bottom-right: x1=960, y1=540, x2=1920, y2=1080

**Supported Formats**: PNG, JPEG, WebP (auto-selected based on output path extension)

**Limits**:
- Maximum ${maxBatchTasks} crop tasks per call${MEDIA_MODE_NOTE_EN}`
        );
    }

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    // 坐标说明：归一化（0-1000）与像素两套
    const batchX1 = pick(
        lang,
        useNormalized ? '裁切区域左上角 X 坐标（0-1000）' : '裁切区域左上角 X 坐标（像素）',
        useNormalized ? 'Crop region top-left X coordinate (0-1000)' : 'Crop region top-left X coordinate (pixels)'
    );
    const batchY1 = pick(
        lang,
        useNormalized ? '裁切区域左上角 Y 坐标（0-1000）' : '裁切区域左上角 Y 坐标（像素）',
        useNormalized ? 'Crop region top-left Y coordinate (0-1000)' : 'Crop region top-left Y coordinate (pixels)'
    );
    const batchX2 = pick(
        lang,
        useNormalized ? '裁切区域右下角 X 坐标（0-1000）' : '裁切区域右下角 X 坐标（像素）',
        useNormalized ? 'Crop region bottom-right X coordinate (0-1000)' : 'Crop region bottom-right X coordinate (pixels)'
    );
    const batchY2 = pick(
        lang,
        useNormalized ? '裁切区域右下角 Y 坐标（0-1000）' : '裁切区域右下角 Y 坐标（像素）',
        useNormalized ? 'Crop region bottom-right Y coordinate (0-1000)' : 'Crop region bottom-right Y coordinate (pixels)'
    );
    const singleX1 = pick(
        lang,
        useNormalized ? '单张模式：裁切区域左上角 X 坐标（0-1000，必填）' : '单张模式：裁切区域左上角 X 坐标（像素，必填）',
        useNormalized ? 'Single mode: Crop region top-left X coordinate (0-1000, required)' : 'Single mode: Crop region top-left X coordinate (pixels, required)'
    );
    const singleY1 = pick(
        lang,
        useNormalized ? '单张模式：裁切区域左上角 Y 坐标（0-1000，必填）' : '单张模式：裁切区域左上角 Y 坐标（像素，必填）',
        useNormalized ? 'Single mode: Crop region top-left Y coordinate (0-1000, required)' : 'Single mode: Crop region top-left Y coordinate (pixels, required)'
    );
    const singleX2 = pick(
        lang,
        useNormalized ? '单张模式：裁切区域右下角 X 坐标（0-1000，必填）' : '单张模式：裁切区域右下角 X 坐标（像素，必填）',
        useNormalized ? 'Single mode: Crop region bottom-right X coordinate (0-1000, required)' : 'Single mode: Crop region bottom-right X coordinate (pixels, required)'
    );
    const singleY2 = pick(
        lang,
        useNormalized ? '单张模式：裁切区域右下角 Y 坐标（0-1000，必填）' : '单张模式：裁切区域右下角 Y 坐标（像素，必填）',
        useNormalized ? 'Single mode: Crop region bottom-right Y coordinate (0-1000, required)' : 'Single mode: Crop region bottom-right Y coordinate (pixels, required)'
    );

    return {
        description,
        images: pick(
            lang,
            '批量模式：裁切任务数组。每个任务可独立配置输入、输出和裁切坐标。即使是单个任务也必须传数组。',
            'Batch mode: Array of crop tasks. Each task can independently configure input, output and crop coordinates. MUST be an array even for single task.'
        ),
        batchImagePath: pick(
            lang,
            '源图片路径（必填）',
            'Source image path (required)'
        ),
        batchOutputPath: pick(
            lang,
            '输出文件路径（必填）',
            'Output file path (required)'
        ),
        batchX1,
        batchY1,
        batchX2,
        batchY2,
        singleImagePath: isMultiRoot
            ? pick(
                lang,
                '单张模式：源图片路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Source image path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：源图片路径（必填）。相对于工作区。',
                'Single mode: Source image path (required). Relative to workspace.'
            ),
        singleOutputPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：输出文件路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Output file path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：输出文件路径（必填）。',
                'Single mode: Output file path (required).'
            ),
        singleX1,
        singleY1,
        singleX2,
        singleY2
    };
}

// ==================== resize_image ====================

export interface ResizeImageDescriptionOptions {
    lang: LocalizationLanguage;
    /** 单次调用允许的最大任务数 */
    maxBatchTasks: number;
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
}

export interface ResizeImageDescriptions {
    /** 顶层说明 */
    description: string;
    /** images 批量数组参数说明 */
    images: string;
    /** 批量任务 image_path 参数说明 */
    batchImagePath: string;
    /** 批量任务 output_path 参数说明 */
    batchOutputPath: string;
    /** 批量任务 width 参数说明 */
    batchWidth: string;
    /** 批量任务 height 参数说明 */
    batchHeight: string;
    /** 单张模式 image_path 参数说明 */
    singleImagePath: string;
    /** 单张模式 output_path 参数说明 */
    singleOutputPath: string;
    /** 单张模式 width 参数说明 */
    singleWidth: string;
    /** 单张模式 height 参数说明 */
    singleHeight: string;
}

/**
 * 生成 resize_image 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 保留动态信息：maxBatchTasks、16384x16384 目标尺寸上限、多根工作区可用名称。
 * 中英文都明确：单任务参数与 images 批量数组是两种互斥模式。
 */
export function buildResizeImageDescriptions(options: ResizeImageDescriptionOptions): ResizeImageDescriptions {
    const { lang, maxBatchTasks, isMultiRoot, workspaceNames } = options;

    let description: string;
    if (lang === 'zh-CN') {
        description = `缩放图片工具。将图片缩放到指定的目标尺寸。

**功能**：
- 将图片缩放到指定的宽度和高度
- 使用拉伸填充模式（不保持宽高比）
- 适用于需要精确尺寸的场景

**参数**：
- width：目标宽度（像素，必填）
- height：目标高度（像素，必填）
- image_path：源图片路径（必填）
- output_path：输出文件路径（必填）

**示例**：
- 缩放到 800x600：width=800, height=600
- 缩放到正方形 512x512：width=512, height=512
- 缩放到 1920x1080：width=1920, height=1080

**支持格式**：PNG、JPEG、WebP（根据输出路径扩展名自动选择）

**限制**：
- 单次调用最多 ${maxBatchTasks} 个缩放任务
- 目标尺寸不能超过 16384x16384${MEDIA_MODE_NOTE_ZH}`;
    } else {
        description = `Resize image tool. Resizes images to specified target dimensions.

**Features**:
- Resize image to specified width and height
- Uses stretch fill mode (does not preserve aspect ratio)
- Suitable for scenarios requiring exact dimensions

**Parameters**:
- width: Target width (pixels, required)
- height: Target height (pixels, required)
- image_path: Source image path (required)
- output_path: Output file path (required)

**Examples**:
- Resize to 800x600: width=800, height=600
- Resize to square 512x512: width=512, height=512
- Resize to 1920x1080: width=1920, height=1080

**Supported Formats**: PNG, JPEG, WebP (auto-selected based on output path extension)

**Limits**:
- Maximum ${maxBatchTasks} resize tasks per call
- Target dimensions cannot exceed 16384x16384${MEDIA_MODE_NOTE_EN}`;
    }

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    return {
        description,
        images: pick(
            lang,
            '批量模式：缩放任务数组。每个任务可独立配置输入、输出和目标尺寸。即使是单个任务也必须传数组。',
            'Batch mode: Resize task array. Each task can independently configure input, output, and target dimensions. MUST be an array even for single task.'
        ),
        batchImagePath: pick(
            lang,
            '源图片路径（必填）',
            'Source image path (required)'
        ),
        batchOutputPath: pick(
            lang,
            '输出文件路径（必填）',
            'Output file path (required)'
        ),
        batchWidth: pick(
            lang,
            '目标宽度（像素，必填）',
            'Target width (pixels, required)'
        ),
        batchHeight: pick(
            lang,
            '目标高度（像素，必填）',
            'Target height (pixels, required)'
        ),
        singleImagePath: isMultiRoot
            ? pick(
                lang,
                '单张模式：源图片路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Source image path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：源图片路径（必填）。相对于工作区。',
                'Single mode: Source image path (required). Relative to workspace.'
            ),
        singleOutputPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：输出文件路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Output file path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：输出文件路径（必填）。',
                'Single mode: Output file path (required).'
            ),
        singleWidth: pick(
            lang,
            '单张模式：目标宽度（像素，必填）',
            'Single mode: Target width (pixels, required)'
        ),
        singleHeight: pick(
            lang,
            '单张模式：目标高度（像素，必填）',
            'Single mode: Target height (pixels, required)'
        )
    };
}

// ==================== rotate_image ====================

export interface RotateImageDescriptionOptions {
    lang: LocalizationLanguage;
    /** 单次调用允许的最大任务数 */
    maxBatchTasks: number;
    /** 是否多根工作区 */
    isMultiRoot: boolean;
    /** 可用工作区名称（多根时动态列出） */
    workspaceNames: string[];
}

export interface RotateImageDescriptions {
    /** 顶层说明 */
    description: string;
    /** images 批量数组参数说明 */
    images: string;
    /** 批量任务 image_path 参数说明 */
    batchImagePath: string;
    /** 批量任务 output_path 参数说明 */
    batchOutputPath: string;
    /** 批量任务 angle 参数说明 */
    batchAngle: string;
    /** 批量任务 format 参数说明 */
    batchFormat: string;
    /** 单张模式 image_path 参数说明 */
    singleImagePath: string;
    /** 单张模式 output_path 参数说明 */
    singleOutputPath: string;
    /** 单张模式 angle 参数说明 */
    singleAngle: string;
    /** 单张模式 format 参数说明 */
    singleFormat: string;
}

/**
 * 生成 rotate_image 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 保留动态信息：maxBatchTasks、多根工作区可用名称。
 * 中英文都明确：单任务参数与 images 批量数组是两种互斥模式。
 */
export function buildRotateImageDescriptions(options: RotateImageDescriptionOptions): RotateImageDescriptions {
    const { lang, maxBatchTasks, isMultiRoot, workspaceNames } = options;

    let description: string;
    if (lang === 'zh-CN') {
        description = `旋转图片工具。将图片顺时针旋转指定角度。

**功能**：
- 支持任意旋转角度（正数、负数、超过 360 度）
- 正角度表示顺时针旋转
- 负角度表示逆时针旋转
- 自动计算最小包围矩形画布

**背景填充**：
- PNG/WebP：透明背景
- JPEG：黑色背景

**参数**：
- angle：旋转角度（必填，正数为顺时针）
- image_path：源图片路径（必填）
- output_path：输出文件路径（必填）
- format：输出格式（可选：png、jpg、jpeg、webp。未指定时使用原格式或根据输出路径推断）

**示例**：
- 顺时针旋转 90°：angle=90
- 逆时针旋转 45°：angle=-45
- 旋转 180°（翻转）：angle=180

**支持格式**：PNG、JPEG、WebP（根据 format 参数或输出路径扩展名选择）

**限制**：
- 单次调用最多 ${maxBatchTasks} 个旋转任务${MEDIA_MODE_NOTE_ZH}`;
    } else {
        description = `Rotate image tool. Rotates images clockwise to specified angle.

**Features**:
- Supports any rotation angle (positive, negative, over 360 degrees)
- Positive angles rotate clockwise
- Negative angles rotate counter-clockwise
- Automatically calculates minimum bounding rectangle canvas

**Background Fill**:
- PNG/WebP: Transparent background
- JPEG: Black background

**Parameters**:
- angle: Rotation angle (required, positive for clockwise)
- image_path: Source image path (required)
- output_path: Output file path (required)
- format: Output format (optional: png, jpg, jpeg, webp. If not specified, uses original format or infers from output path)

**Examples**:
- Rotate 90° clockwise: angle=90
- Rotate 45° counter-clockwise: angle=-45
- Rotate 180° (flip): angle=180

**Supported Formats**: PNG, JPEG, WebP (selected based on format parameter or output path extension)

**Limits**:
- Maximum ${maxBatchTasks} rotate tasks per call${MEDIA_MODE_NOTE_EN}`;
    }

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    return {
        description,
        images: pick(
            lang,
            '批量模式：旋转任务数组。每个任务可独立配置输入、输出、角度和格式。即使是单个任务也必须传数组。',
            'Batch mode: Rotate task array. Each task can independently configure input, output, angle, and format. MUST be an array even for single task.'
        ),
        batchImagePath: pick(
            lang,
            '源图片路径（必填）',
            'Source image path (required)'
        ),
        batchOutputPath: pick(
            lang,
            '输出文件路径（必填）',
            'Output file path (required)'
        ),
        batchAngle: pick(
            lang,
            '旋转角度（必填，正数为顺时针，可为任意值）',
            'Rotation angle (required, positive for clockwise, any value)'
        ),
        batchFormat: pick(
            lang,
            '输出格式（可选：png、jpg、jpeg、webp）',
            'Output format (optional: png, jpg, jpeg, webp)'
        ),
        singleImagePath: isMultiRoot
            ? pick(
                lang,
                '单张模式：源图片路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Source image path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：源图片路径（必填）。相对于工作区。',
                'Single mode: Source image path (required). Relative to workspace.'
            ),
        singleOutputPath: isMultiRoot
            ? pick(
                lang,
                '单张模式：输出文件路径（必填）。必须使用 "workspace_name/path" 格式。',
                'Single mode: Output file path (required). Use "workspace_name/path" format.'
            )
            : pick(
                lang,
                '单张模式：输出文件路径（必填）。',
                'Single mode: Output file path (required).'
            ),
        singleAngle: pick(
            lang,
            '单张模式：旋转角度（必填，正数为顺时针，可为任意值）',
            'Single mode: Rotation angle (required, positive for clockwise, any value)'
        ),
        singleFormat: pick(
            lang,
            '单张模式：输出格式（可选：png、jpg、jpeg、webp）',
            'Single mode: Output format (optional: png, jpg, jpeg, webp)'
        )
    };
}
