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
import { toolBatchingGuidance } from '../shared/batchingGuidance';

/** 按语言选择文本 */
function pick(lang: LocalizationLanguage, zhText: string, enText: string): string {
    return lang === 'zh-CN' ? zhText : enText;
}

// ==================== 通用说明片段 ====================

/** 图片工具：单任务参数与 images 批量数组互斥模式说明 */
function mediaModeNote(lang: LocalizationLanguage, singleParams: string, maxBatchTasks: number): string {
    return pick(
        lang,
        `\n\n单张模式使用 ${singleParams}；批量模式使用 images 数组，最多 ${maxBatchTasks} 个任务。两种模式互斥，只能选择一种，不要同时发送。`,
        `\n\nSingle mode uses ${singleParams}; batch mode uses the images array, with at most ${maxBatchTasks} tasks. The two modes are mutually exclusive, so send only one of them.`
    );
}

/** 多根工作区尾巴（可用工作区名称保留运行时插值） */
function multiRootTail(lang: LocalizationLanguage, workspaceNames: string[]): string {
    // workspaceNames 为空时省略工作区列表，避免输出 "可用工作区：" 空尾巴；保留多根提示本身。
    if (workspaceNames.length === 0) {
        return pick(
            lang,
            '\n\n当前是多根工作区，所有路径都要使用 "workspace_name/path" 格式。',
            '\n\nThis is a multi-root workspace, so every path must use the "workspace_name/path" format.'
        );
    }
    return pick(
        lang,
        `\n\n当前是多根工作区，所有路径都要使用 "workspace_name/path" 格式。可用工作区：${workspaceNames.join(', ')}。`,
        `\n\nThis is a multi-root workspace, so every path must use the "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}.`
    );
}

/** 图片工具路径参数：单根时说明相对工作区，多根时格式已在主说明中给出 */
function mediaPathText(lang: LocalizationLanguage, isMultiRoot: boolean): string {
    return isMultiRoot
        ? pick(lang, '格式为 "workspace_name/path"。', 'Use the "workspace_name/path" format.')
        : pick(lang, '相对于工作区根目录。', 'Relative to the workspace root.');
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
    /** 顶层 encoding 参数说明 */
    encoding: string;
    /** files[].encoding 参数说明 */
    batchEncoding: string;
}

/**
 * 生成 read_file 的语言感知说明（顶层 + 全部参数说明）。
 *
 * 顶层说明按多模态能力分支：
 * - 未启用多模态 / OpenAI function_call 回退：纯文本；
 * - OpenAI 其他模式（xml/json）：文本 + 图片（常见图片格式）；
 * - Gemini / Anthropic：文本 + 图片 + 文档（PDF）。
 *
 * 中英文都明确：path 与 files 互斥、顶层 startLine/endLine 只属于单文件模式、
 * files[].startLine/endLine 属于批量模式、行范围只适用于文本、行号前缀不是正文。
 * 跨参数规则只写在顶层说明里，参数说明不再重复。
 */
export function buildReadFileDescriptions(options: ReadFileDescriptionOptions): ReadFileDescriptions {
    const { lang, isMultiRoot, workspaceNames } = options;

    // 用法：path / files 互斥、行范围的写法与大文件的读取方式。
    // 单文件兼容别名（line/maxLine/maxLines/limit）不再写进描述和 schema 向模型宣传：
    // 每轮请求都会携带工具声明，别名参数既烧 token 又鼓励旧写法。
    // 它们仍通过 declaration 的 paramAliases/compatParams 被接受（见 read_file.ts 声明）。
    const usageNote = pick(
        lang,
        '\n\npath 与 files 二选一。单文件用顶层 startLine/endLine，批量时各 files 项单独设置；省略 endLine 读取至末尾。先用搜索或符号定位，未知位置的大文件从第 1 行分段读，根据总行数继续。',
        '\n\nUse either path or files. Set top-level startLine/endLine for one file, or set them per files item for a batch; omitting endLine reads to EOF. Locate content with search or symbols first. When its location is unknown, read large files in chunks from line 1 and continue using the returned total line count.'
    );

    // 结果：行号前缀不是正文；非 UTF-8 文本会自动识别编码
    const lineNumberNote = pick(
        lang,
        '\n\n文本行号前缀（如 "1 |"）仅供定位，编辑时不要写回。自动识别非 UTF-8 编码：encoding 给出编码，encodingGuessed 表示推测；无 encoding 即 UTF-8。',
        '\n\nText line-number prefixes such as "1 |" are for location only; do not write them back. Non-UTF-8 encodings are detected automatically: encoding names the encoding and encodingGuessed marks a content-based guess. No encoding field means UTF-8.'
    );

    // 限制：行范围只适用于文本（仅多模态分支需要）
    const binaryNote = pick(
        lang,
        '\n\n行范围只对文本文件有效。读取图片、PDF、音频、视频等非文本文件时不需要填写，填了也会被忽略。',
        '\n\nLine ranges only apply to text files. Leave them out for images, PDFs, audio, video and other non-text files; they are ignored if given.'
    );

    let description: string;

    if (!options.multimodalEnabled || (options.channelType === 'openai' && options.toolMode === 'function_call')) {
        // 未启用多模态，或 OpenAI function_call 模式（不支持多模态）：只支持文本文件
        description = pick(
            lang,
            '读取工作区中的一个或多个文件，目前只支持文本文件。',
            'Read one or more files from the workspace. Only text files are supported.'
        ) + usageNote + lineNumberNote;
    } else if (options.channelType === 'openai') {
        // OpenAI xml/json 模式只支持图片
        description = pick(
            lang,
            '读取工作区中的一个或多个文件，支持文本文件和图片（PNG/JPEG/WebP/GIF/BMP 等常见格式），图片会以多模态数据返回。',
            'Read one or more files from the workspace. Text files and images (common formats such as PNG/JPEG/WebP/GIF/BMP) are supported; images are returned as multimodal data.'
        ) + usageNote + lineNumberNote + binaryNote;
    } else {
        // Gemini 和 Anthropic 全面支持
        description = pick(
            lang,
            '读取工作区中的一个或多个文件，支持文本文件、图片（PNG/JPEG/WebP/GIF/BMP 等常见格式）和 PDF 文档，图片和文档会以多模态数据返回。',
            'Read one or more files from the workspace. Text files, images (common formats such as PNG/JPEG/WebP/GIF/BMP) and PDF documents are supported; images and documents are returned as multimodal data.'
        ) + usageNote + lineNumberNote + binaryNote;
    }

    // 多根工作区：path 与 files[].path 都必须带工作区前缀，可用名称列在路径参数里
    if (isMultiRoot) {
        description += pick(
            lang,
            '\n\n当前是多根工作区，path 和 files[].path 都要使用 "workspace_name/path" 格式。',
            '\n\nThis is a multi-root workspace, so both path and files[].path must use the "workspace_name/path" format.'
        );
    }

    const path = isMultiRoot
        ? pick(
            lang,
            `要读取的单个文件路径，格式为 "workspace_name/path"。可用工作区：${workspaceNames.join(', ')}。`,
            `Path of the single file to read, in the "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}.`
        )
        : pick(
            lang,
            '要读取的单个文件路径，相对于工作区根目录，例如 src/main.ts。',
            'Path of the single file to read, relative to the workspace root, for example src/main.ts.'
        );

    const batchPath = isMultiRoot
        ? pick(
            lang,
            `文件路径，格式为 "workspace_name/path"。可用工作区：${workspaceNames.join(', ')}。`,
            `File path in the "workspace_name/path" format. Available workspaces: ${workspaceNames.join(', ')}.`
        )
        : pick(
            lang,
            '文件路径，相对于工作区根目录，例如 src/main.ts。',
            'File path relative to the workspace root, for example src/main.ts.'
        );

    description += toolBatchingGuidance(lang);
    return {
        description,
        path,
        batchPath,
        files: pick(
            lang,
            '批量读取的文件列表，每一项可以单独设置行范围。',
            'Files to read in batch mode; each item can have its own line range.'
        ),
        startLine: pick(
            lang,
            '起始行号，从 1 开始，包含这一行。',
            'First line to read, 1-based and inclusive.'
        ),
        endLine: pick(
            lang,
            '结束行号，从 1 开始，包含这一行。只给 endLine 时从第 1 行读起。',
            'Last line to read, 1-based and inclusive. If only endLine is given, reading starts at line 1.'
        ),
        batchStartLine: pick(
            lang,
            '这个文件的起始行号，从 1 开始，包含这一行。',
            'First line to read in this file, 1-based and inclusive.'
        ),
        batchEndLine: pick(
            lang,
            '这个文件的结束行号，从 1 开始，包含这一行。',
            'Last line to read in this file, 1-based and inclusive.'
        ),
        encoding: pick(
            lang,
            '可选，按指定编码解码文本，例如 gbk、gb18030、shift_jis、big5、euc-kr、utf-16le。只在自动识别不对时填写；批量读取时作为未单独指定的项的默认值。',
            'Optional encoding to decode the text with, such as gbk, gb18030, shift_jis, big5, euc-kr or utf-16le. Set it only when automatic detection is wrong; in batch mode it is the default for items that do not set their own.'
        ),
        batchEncoding: pick(
            lang,
            '可选，这个文件的编码，用法同顶层 encoding。',
            'Optional encoding for this file; same as the top-level encoding.'
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
        paramNotes.push(config.forcedAspectRatio
            ? pick(lang, `宽高比已由用户固定为 ${config.forcedAspectRatio}，不能更改。`, `The user has fixed the aspect ratio at ${config.forcedAspectRatio}; it cannot be changed.`)
            : pick(lang, '可以用 aspect_ratio 指定宽高比（可选）。', 'You can set the aspect ratio with aspect_ratio (optional).'));
    }
    if (config.enableImageSize) {
        paramNotes.push(config.forcedImageSize
            ? pick(lang, `图片尺寸已由用户固定为 ${config.forcedImageSize}，不能更改。`, `The user has fixed the image size at ${config.forcedImageSize}; it cannot be changed.`)
            : pick(lang, '可以用 image_size 指定分辨率（可选）。', 'You can set the resolution with image_size (optional).'));
    }
    const paramSection = paramNotes.length > 0 ? pick(lang, '', ' ') + paramNotes.join(pick(lang, '', ' ')) : '';

    let description = pick(
        lang,
        `用 AI 根据提示词生成图片、修改参考图或合成多图，保存到指定路径并返回供查看。提示词可用自然语言或关键词。

生成结果带纯色背景，需要透明背景时再用 remove_background。

每次调用最多 ${maxBatchTasks} 个生成任务，每个任务最多保存 ${maxImagesPerTask} 张图片。${paramSection}${mediaModeNote(lang, 'prompt + output_path', maxBatchTasks)}`,
        `Generate images from prompts, edit references or combine multiple images with AI; save to the given path and return for viewing. Prompts may use sentences or keywords.

Results have a solid background; use remove_background when transparency is needed.

Each call can run at most ${maxBatchTasks} generation tasks, and each task saves at most ${maxImagesPerTask} images.${paramSection}${mediaModeNote(lang, 'prompt + output_path', maxBatchTasks)}`
    );

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    const pathText = mediaPathText(lang, isMultiRoot);
    const aspectRatioText = pick(
        lang,
        '可选，图片宽高比，可选值：1:1、3:2、2:3、3:4、4:3、4:5、5:4、9:16、16:9、21:9。',
        'Optional aspect ratio: 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9 or 21:9.'
    );
    const imageSizeText = pick(
        lang,
        '可选，图片分辨率：1K=1024px，2K=2048px，4K=4096px。',
        'Optional resolution: 1K=1024px, 2K=2048px, 4K=4096px.'
    );
    const referenceImagesText = pick(
        lang,
        '可选，参考图片路径数组，最多 14 张。即使只有一张也要传数组，例如 ["image.png"]。',
        'Optional array of reference image paths, up to 14. Pass an array even for one image, for example ["image.png"].'
    );

    return {
        description,
        images: pick(
            lang,
            '批量模式的任务数组，每个任务可以单独设置提示词、参考图片和输出路径。即使只有一个任务也要传数组，例如 [{"prompt": "...", "output_path": "..."}]。',
            'Task array for batch mode; each task has its own prompt, reference images and output path. Pass an array even for one task, for example [{"prompt": "...", "output_path": "..."}].'
        ),
        batchPrompt: pick(lang, '图片生成提示词。', 'Image generation prompt.'),
        batchReferenceImages: referenceImagesText,
        batchOutputPath: pick(lang, '输出文件路径，必填。', 'Output file path; required.'),
        batchAspectRatio: aspectRatioText,
        batchImageSize: imageSizeText,
        singlePrompt: pick(lang, '单张模式的图片生成提示词。', 'Image generation prompt for single mode.'),
        singleReferenceImages: pick(lang, '单张模式：', 'Single mode: ') + referenceImagesText,
        singleReferenceImageItem: pick(lang, '参考图片路径，', 'Reference image path. ') + pathText,
        singleOutputPath: pick(lang, '单张模式的输出文件路径，必填，', 'Output file path for single mode; required. ') + pathText,
        singleAspectRatio: pick(lang, '单张模式：', 'Single mode: ') + aspectRatioText,
        singleImageSize: pick(lang, '单张模式：', 'Single mode: ') + imageSizeText
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

    let description = pick(
        lang,
        `用 AI 遮罩移除图片背景，保存为透明 PNG。遮罩中主体为黑色、背景为白色。${mediaModeNote(lang, 'image_path + output_path', maxBatchTasks)}`,
        `Remove image backgrounds with an AI mask and save transparent PNGs. The mask uses black for the subject and white for the background.${mediaModeNote(lang, 'image_path + output_path', maxBatchTasks)}`
    );

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    const pathText = mediaPathText(lang, isMultiRoot);
    const subjectText = pick(
        lang,
        '可选，要保留的主体描述，例如"人"、"商品"、"猫"，可以帮助 AI 更准确地识别主体。',
        'Optional description of the subject to keep, such as "person", "product" or "cat"; it helps the AI identify the subject more accurately.'
    );
    const maskText = pick(
        lang,
        '可选，提供时会把遮罩图另存到这个路径。',
        'Optional; when given, the mask image is also saved to this path.'
    );

    return {
        description,
        images: pick(
            lang,
            '批量模式的任务数组，每个任务可以单独设置输入、输出和主体描述。即使只有一个任务也要传数组。',
            'Task array for batch mode; each task has its own input, output and subject description. Pass an array even for one task.'
        ),
        batchImagePath: pick(lang, '源图片路径，必填。', 'Source image path; required.'),
        batchOutputPath: pick(lang, '输出文件路径，必填，建议使用 .png 扩展名。', 'Output file path; required. A .png extension is recommended.'),
        batchSubjectDescription: subjectText,
        batchMaskPath: maskText,
        singleImagePath: pick(lang, '单张模式的源图片路径，必填，', 'Source image path for single mode; required. ') + pathText,
        singleOutputPath: pick(lang, '单张模式的输出文件路径，必填，建议使用 .png 扩展名，', 'Output file path for single mode; required, and a .png extension is recommended. ') + pathText,
        singleSubjectDescription: pick(lang, '单张模式：', 'Single mode: ') + subjectText,
        singleMaskPath: pick(lang, '单张模式：', 'Single mode: ') + maskText + (isMultiRoot ? pick(lang, '', ' ') + pathText : '')
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

    const coordinateText = useNormalized
        ? pick(
            lang,
            '按归一化坐标（0-1000）裁切图片，(0, 0) 为左上角，(1000, 1000) 为右下角，自动换算成像素。x1、y1 为裁切区域左上角，x2、y2 为右下角，要求 x1 < x2、y1 < y2。',
            'Crop using normalized coordinates (0-1000), from top-left (0, 0) to bottom-right (1000, 1000), converted to pixels automatically. x1, y1 is the crop top-left and x2, y2 its bottom-right; require x1 < x2 and y1 < y2.'
        )
        : pick(
            lang,
            '按图片实际像素坐标裁切，(0, 0) 为左上角。根据图片尺寸指定区域：x1、y1 为左上角，x2、y2 为右下角，要求 x1 < x2、y1 < y2。',
            'Crop using the image\'s actual pixel coordinates, with (0, 0) at the top-left. Set x1, y1 to the crop top-left and x2, y2 to its bottom-right using the image dimensions; require x1 < x2 and y1 < y2.'
        );

    let description = coordinateText + pick(
        lang,
        '\n\n输出格式由输出路径的扩展名决定，支持 PNG、JPEG 和 WebP。',
        '\n\nThe output format follows the output path extension; PNG, JPEG and WebP are supported.'
    ) + mediaModeNote(lang, 'image_path + output_path + x1/y1/x2/y2', maxBatchTasks);

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    // 坐标说明：归一化（0-1000）与像素两套
    const unit = useNormalized ? '0-1000' : pick(lang, '像素', 'pixels');
    const coord = (zhCorner: string, enCorner: string, axis: string, single: boolean): string => pick(
        lang,
        `${single ? '单张模式：' : ''}裁切区域${zhCorner} ${axis} 坐标（${unit}${single ? '，必填' : ''}）。`,
        `${single ? 'Single mode: ' : ''}${axis} coordinate of the crop area's ${enCorner} (${unit}${single ? ', required' : ''}).`
    );
    const pathText = mediaPathText(lang, isMultiRoot);

    return {
        description,
        images: pick(
            lang,
            '批量模式的任务数组，每个任务可以单独设置输入、输出和裁切坐标。即使只有一个任务也要传数组。',
            'Task array for batch mode; each task has its own input, output and crop coordinates. Pass an array even for one task.'
        ),
        batchImagePath: pick(lang, '源图片路径，必填。', 'Source image path; required.'),
        batchOutputPath: pick(lang, '输出文件路径，必填。', 'Output file path; required.'),
        batchX1: coord('左上角', 'top-left corner', 'X', false),
        batchY1: coord('左上角', 'top-left corner', 'Y', false),
        batchX2: coord('右下角', 'bottom-right corner', 'X', false),
        batchY2: coord('右下角', 'bottom-right corner', 'Y', false),
        singleImagePath: pick(lang, '单张模式的源图片路径，必填，', 'Source image path for single mode; required. ') + pathText,
        singleOutputPath: pick(lang, '单张模式的输出文件路径，必填，', 'Output file path for single mode; required. ') + pathText,
        singleX1: coord('左上角', 'top-left corner', 'X', true),
        singleY1: coord('左上角', 'top-left corner', 'Y', true),
        singleX2: coord('右下角', 'bottom-right corner', 'X', true),
        singleY2: coord('右下角', 'bottom-right corner', 'Y', true)
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

    let description = pick(
        lang,
        `把图片拉伸到指定宽高（像素），不保持原宽高比，尺寸不能超过 16384x16384。输出格式按路径扩展名确定，支持 PNG、JPEG 和 WebP。${mediaModeNote(lang, 'image_path + output_path + width + height', maxBatchTasks)}`,
        `Stretch images to the specified width and height in pixels without preserving aspect ratio, at most 16384x16384. The output path extension selects PNG, JPEG or WebP.${mediaModeNote(lang, 'image_path + output_path + width + height', maxBatchTasks)}`
    );

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    const pathText = mediaPathText(lang, isMultiRoot);

    return {
        description,
        images: pick(
            lang,
            '批量模式的任务数组，每个任务可以单独设置输入、输出和目标尺寸。即使只有一个任务也要传数组。',
            'Task array for batch mode; each task has its own input, output and target size. Pass an array even for one task.'
        ),
        batchImagePath: pick(lang, '源图片路径，必填。', 'Source image path; required.'),
        batchOutputPath: pick(lang, '输出文件路径，必填。', 'Output file path; required.'),
        batchWidth: pick(lang, '目标宽度（像素），必填。', 'Target width in pixels; required.'),
        batchHeight: pick(lang, '目标高度（像素），必填。', 'Target height in pixels; required.'),
        singleImagePath: pick(lang, '单张模式的源图片路径，必填，', 'Source image path for single mode; required. ') + pathText,
        singleOutputPath: pick(lang, '单张模式的输出文件路径，必填，', 'Output file path for single mode; required. ') + pathText,
        singleWidth: pick(lang, '单张模式的目标宽度（像素），必填。', 'Target width in pixels for single mode; required.'),
        singleHeight: pick(lang, '单张模式的目标高度（像素），必填。', 'Target height in pixels for single mode; required.')
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

    let description = pick(
        lang,
        `按 angle 旋转图片，正数顺时针，负数逆时针，允许超过 360°。画布扩大至容纳旋转结果，空白区域在 PNG/WebP 中透明、JPEG 中为黑色。format 优先于输出扩展名，支持 PNG、JPEG 和 WebP。${mediaModeNote(lang, 'image_path + output_path + angle', maxBatchTasks)}`,
        `Rotate by angle: positive clockwise, negative counter-clockwise, values over 360° allowed. The canvas expands to fit; uncovered areas are transparent in PNG/WebP and black in JPEG. format takes precedence over the output extension; PNG, JPEG and WebP are supported.${mediaModeNote(lang, 'image_path + output_path + angle', maxBatchTasks)}`
    );

    if (isMultiRoot) {
        description += multiRootTail(lang, workspaceNames);
    }

    const pathText = mediaPathText(lang, isMultiRoot);
    const angleText = pick(
        lang,
        '旋转角度，必填，正数顺时针，可以是任意值。',
        'Rotation angle; required. Positive is clockwise, and any value is allowed.'
    );
    const formatText = pick(
        lang,
        '可选，输出格式：png、jpg、jpeg 或 webp。省略时沿用原格式或按输出路径推断。',
        'Optional output format: png, jpg, jpeg or webp. When omitted, the original format is kept or inferred from the output path.'
    );

    return {
        description,
        images: pick(
            lang,
            '批量模式的任务数组，每个任务可以单独设置输入、输出、角度和格式。即使只有一个任务也要传数组。',
            'Task array for batch mode; each task has its own input, output, angle and format. Pass an array even for one task.'
        ),
        batchImagePath: pick(lang, '源图片路径，必填。', 'Source image path; required.'),
        batchOutputPath: pick(lang, '输出文件路径，必填。', 'Output file path; required.'),
        batchAngle: angleText,
        batchFormat: formatText,
        singleImagePath: pick(lang, '单张模式的源图片路径，必填，', 'Source image path for single mode; required. ') + pathText,
        singleOutputPath: pick(lang, '单张模式的输出文件路径，必填，', 'Output file path for single mode; required. ') + pathText,
        singleAngle: pick(lang, '单张模式：', 'Single mode: ') + angleText,
        singleFormat: pick(lang, '单张模式：', 'Single mode: ') + formatText
    };
}
