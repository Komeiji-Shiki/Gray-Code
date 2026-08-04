/**
 * CheckpointExclusionProfiles - 默认排除类别定义（EX-03 ~ EX-06）
 *
 * 定义四层排除模型中的「第二层：默认排除类别」：
 * - 每个类别（profile）有一组默认 gitignore 模式
 * - 类别可在设置页分别开关（CheckpointExclusionConfig.enabledProfiles）
 * - 用户自定义否定规则（!pattern）可以重新纳入默认类别，但不能覆盖强制排除
 *
 * 模式清单严格参照 checkpoint-history-branch-architecture.plan.md
 * 「第二部分 §2 建议默认排除模式」（L531~L682）。
 *
 * 注意：*.bin / *.dat / *.model 不建议默认排除（过于通用，可能包含项目
 * 真正需要恢复的小型文件）；env/ 不默认排除（避免误伤配置目录）；
 * *.png / *.jpg / *.svg 不默认排除（前端项目重要源码资源）。
 */
import type {
    CheckpointExclusionProfileId,
    CheckpointIgnoreSnapshot
} from './types';

/** 默认类别规则版本（随 manifest/快照保存，恢复时用于规则对比） */
export const CHECKPOINT_EXCLUSION_PROFILE_VERSION = 1;

/** 强制排除规则版本（.git / node_modules / 扩展存储绝对路径） */
export const FORCED_RULES_VERSION = 1;

/** 排除配置快照版本 */
export const CHECKPOINT_EXCLUSION_CONFIG_VERSION = 1;

/** 单文件大小上限默认值：50 MiB（EX-07；0 = 不限制） */
export const DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** 单个默认排除类别 */
export interface CheckpointExclusionProfile {
    id: CheckpointExclusionProfileId;
    /** 显示名（英文稳定名；设置页展示请按 id 走前端 i18n） */
    displayName: string;
    /** gitignore 语法模式清单 */
    patterns: readonly string[];
    /** 是否默认启用 */
    defaultEnabled: boolean;
    /** 简要说明 */
    description: string;
}

/**
 * 默认排除类别清单（顺序即设置页展示顺序）。
 *
 * 模式来源：计划文档 L531~L682。
 */
export const DEFAULT_EXCLUSION_PROFILES: readonly CheckpointExclusionProfile[] = [
    {
        id: 'logs',
        displayName: 'Logs',
        defaultEnabled: true,
        description: 'Log files and log directories',
        patterns: [
            '*.log',
            '*.log.*',
            'logs/',
            'log/',
            'npm-debug.log*',
            'yarn-debug.log*',
            'yarn-error.log*',
            'pnpm-debug.log*',
            'lerna-debug.log*'
        ]
    },
    {
        id: 'aiModels',
        displayName: 'AI/ML Models',
        defaultEnabled: true,
        description: 'AI/ML model weights and shards (not *.bin / *.dat / *.model)',
        patterns: [
            '*.safetensors',
            '*.pt',
            '*.pth',
            '*.onnx',
            '*.h5',
            '*.hdf5',
            '*.pb',
            '*.ckpt',
            '*.gguf',
            '*.ggml',
            '*.tflite',
            '*.torchscript',
            '*.mlmodel',
            '*.joblib',
            '*.engine',
            '*.trt',
            '*.mar'
        ]
    },
    {
        id: 'datasets',
        displayName: 'Datasets',
        defaultEnabled: true,
        description: 'Datasets and large-scale data directories',
        patterns: [
            'data/',
            'datasets/',
            'dataset/',
            '*.parquet',
            '*.arrow',
            '*.feather',
            '*.tfrecord'
        ]
    },
    {
        id: 'caches',
        displayName: 'Caches',
        defaultEnabled: true,
        description: 'Cache and bytecode directories',
        patterns: [
            '.cache/',
            '.mypy_cache/',
            '.pytest_cache/',
            '.ruff_cache/',
            '.hypothesis/',
            '.tox/',
            '.nox/',
            '__pycache__/',
            '*.pyc',
            '*.pyo'
        ]
    },
    {
        id: 'pythonVenvs',
        displayName: 'Python Virtual Environments',
        defaultEnabled: true,
        description: 'Python virtual environments (not plain env/)',
        patterns: [
            '.venv/',
            'venv/',
            'virtualenv/'
        ]
    },
    {
        id: 'buildArtifacts',
        displayName: 'Build Artifacts',
        defaultEnabled: true,
        description: 'Build outputs and coverage directories',
        patterns: [
            'dist/',
            'build/',
            '.next/',
            '.nuxt/',
            '.gradle/',
            'target/',
            'coverage/',
            '.nyc_output/',
            '*.tsbuildinfo'
        ]
    },
    {
        id: 'largeMedia',
        displayName: 'Large Media',
        defaultEnabled: true,
        description: 'Large media and design source files (not png/jpg/svg)',
        patterns: [
            '*.mp4',
            '*.mkv',
            '*.mov',
            '*.avi',
            '*.flac',
            '*.psd',
            '*.tiff',
            '*.raw'
        ]
    },
    {
        id: 'archives',
        displayName: 'Archives & Binaries',
        defaultEnabled: true,
        description: 'Compressed archives and binary artifacts',
        patterns: [
            '*.zip',
            '*.tar',
            '*.tar.gz',
            '*.tgz',
            '*.7z',
            '*.rar',
            '*.iso',
            '*.dmg',
            '*.exe',
            '*.dll'
        ]
    }
];

/** 默认启用状态：全部类别默认开启 */
export const DEFAULT_ENABLED_PROFILES: Record<string, boolean> = Object.fromEntries(
    DEFAULT_EXCLUSION_PROFILES.map(profile => [profile.id, true])
);

/** 按 id 查找类别（未找到返回 undefined） */
export function getExclusionProfile(
    id: string
): CheckpointExclusionProfile | undefined {
    return DEFAULT_EXCLUSION_PROFILES.find(profile => profile.id === id);
}

/**
 * 解析启用的类别 id 列表。
 *
 * 语义（全项目统一）：
 * - `enabledProfiles === undefined`：按「全部默认启用」处理（设置页默认全开）
 * - `enabledProfiles === {}`（空对象）：同样全部按默认启用（全开）——
 *   前端永不发送 `{}` 表示全关，全关必须显式写 `false`（前端保存的是完整记录，含全部类别）
 * - 单个类别缺省（未在对象中列出）：按该类别默认启用状态处理
 * - 需要关闭某个类别时，显式传 `false`
 */
export function resolveEnabledProfiles(
    enabledProfiles?: Record<string, boolean>
): CheckpointExclusionProfileId[] {
    return DEFAULT_EXCLUSION_PROFILES
        .filter(profile => enabledProfiles === undefined
            ? profile.defaultEnabled
            : (enabledProfiles[profile.id] ?? profile.defaultEnabled))
        .map(profile => profile.id);
}

/**
 * 收集启用的默认类别模式（扁平化，用于 resolver 根作用域注入）。
 *
 * 与 resolveEnabledProfiles 相同的缺省语义。
 */
export function collectEnabledProfilePatterns(
    enabledProfiles?: Record<string, boolean>
): string[] {
    const enabled = resolveEnabledProfiles(enabledProfiles);
    const enabledSet = new Set(enabled);
    return DEFAULT_EXCLUSION_PROFILES
        .filter(profile => enabledSet.has(profile.id))
        .flatMap(profile => [...profile.patterns]);
}

/**
 * 构建排除规则快照（EX-10，随 manifest 保存；恢复时用于解释“当时为什么没备份”）。
 */
export function buildIgnoreSnapshot(config: {
    enabledProfiles?: Record<string, boolean>;
    maxFileSizeBytes?: number;
    customPatterns?: string[];
}): CheckpointIgnoreSnapshot {
    return {
        version: CHECKPOINT_EXCLUSION_CONFIG_VERSION,
        forcedRulesVersion: FORCED_RULES_VERSION,
        defaultProfileVersion: CHECKPOINT_EXCLUSION_PROFILE_VERSION,
        enabledProfiles: { ...DEFAULT_ENABLED_PROFILES, ...(config.enabledProfiles ?? {}) },
        maxFileSizeBytes: typeof config.maxFileSizeBytes === 'number' && config.maxFileSizeBytes > 0
            ? config.maxFileSizeBytes
            : 0,
        customPatterns: [...(config.customPatterns ?? [])]
    };
}

/** 自定义排除模式校验失败原因 */
export type CheckpointExclusionPatternIssueReason =
    | 'empty'          // 空模式 / 空白
    | 'absolute'       // 绝对路径模式（Windows 盘符 / UNC）
    | 'negation_only'  // 纯 `!`（无实际规则体）
    | 'traversal'      // `..` 越界模式
    | 'newline';       // 包含换行（疑似注入）

export interface CheckpointExclusionPatternIssue {
    pattern: string;
    reason: CheckpointExclusionPatternIssueReason;
}

/**
 * 校验自定义排除模式（EX-12）。
 *
 * 拒绝：
 * - 空 / 纯空白模式
 * - 绝对路径模式（`C:\...`、`\\server\...`、`//...`；gitignore 的 `/anchored` 仍合法）
 * - 纯 `!`（无规则体）
 * - 含 `..` 越界的模式（`../foo`、`a/../../b`）
 * - 包含换行的模式（多行注入）
 *
 * 返回所有问题；无问题时返回空数组。
 */
export function validateCustomExclusionPatterns(
    patterns: readonly unknown[]
): CheckpointExclusionPatternIssue[] {
    const issues: CheckpointExclusionPatternIssue[] = [];

    for (const raw of patterns) {
        const pattern = typeof raw === 'string' ? raw : String(raw ?? '');

        if (!pattern.trim()) {
            issues.push({ pattern, reason: 'empty' });
            continue;
        }
        if (pattern.includes('\n') || pattern.includes('\r')) {
            issues.push({ pattern, reason: 'newline' });
            continue;
        }

        const normalized = pattern.replace(/\\/g, '/');
        const body = normalized.startsWith('!') ? normalized.slice(1) : normalized;

        if (!body.trim() || body === '/') {
            issues.push({ pattern, reason: 'negation_only' });
            continue;
        }
        // Windows 盘符（C:/...）或 UNC（//server/share）
        if (/^[A-Za-z]:\//.test(body) || /^\/\//.test(body)) {
            issues.push({ pattern, reason: 'absolute' });
            continue;
        }
        // `..` 越界：任何路径段为 `..` 都拒绝
        const segments = body.replace(/\/+$/g, '').split('/').filter(segment => segment !== '' && segment !== '.');
        if (segments.some(segment => segment === '..')) {
            issues.push({ pattern, reason: 'traversal' });
        }
    }

    return issues;
}
