import * as fs from 'fs/promises';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import type {
    CheckpointExcludeReason,
    CheckpointExclusionProfileId
} from './types';
import {
    collectEnabledProfilePatterns,
    getExclusionProfile,
    resolveEnabledProfiles
} from './CheckpointExclusionProfiles';
// C-11: 强制排除绝对路径判断统一引用 checkpointPathUtils 单实现，避免两份重复逻辑漂移
import { isExcludedAbsolutePath } from './checkpointPathUtils';

/**
 * CheckpointIgnoreResolver
 *
 * 职责：
 * - 以标准 `.gitignore` 语义解析检查点的忽略范围（四层排除模型，EX-01）
 * - 在遍历工作区时按目录作用域逐层叠加规则
 * - 为快照收集、空目录清理、恢复过滤提供统一的判断入口
 *
 * 四层排除模型（优先级从高到低）：
 * 1. 强制排除（forced）：`.git` / `node_modules` 目录片段 + 扩展存储绝对路径。
 *    任何 `!` 否定规则都不能重新纳入。
 * 2. 默认排除类别（default）：日志、AI/ML 模型、数据集、缓存、Python 虚拟环境、
 *    构建产物、大型媒体、压缩包（CheckpointExclusionProfiles）。
 *    可在设置页分别关闭；用户自定义 `!` 规则可以重新纳入。
 * 3. 项目 `.gitignore`（gitignore）：根目录 + 嵌套，支持 anchored / 否定 / 目录作用域。
 * 4. 用户自定义模式（custom）：设置页添加的规则最后生效——在所有作用域（含嵌套
 *    `.gitignore` / 默认类别）求值之后作为独立最终阶段再执行一次，双向覆盖；
 *    但不能覆盖强制排除。
 *
 * 设计约束：
 * - 所有相对路径在进入匹配逻辑前都规范化为 POSIX 风格
 * - 嵌套 `.gitignore` 只影响其所在目录子树
 * - 当前模块只关心“检查点应该看到什么”，不负责检查点记录本身
 * - `enabledProfiles` 未提供时（如恢复过滤等直接使用场景）不启用默认类别层，
 *   保持历史行为；快照构建器（CheckpointSnapshotBuilder）会显式传入设置解析结果
 */
export interface CheckpointIgnoreResult {
    ignored: boolean;
    reason?: CheckpointExcludeReason;
    /** 命中的具体规则模式（如 `*.log`、`logs/`）；gitignore/自定义/默认类别才有 */
    rule?: string;
    /** 规则来源说明（默认类别 id、`.gitignore` 路径、`custom`、`forced`、`storage`） */
    source?: string;
}

/** 解析器构造选项（EX-01/EX-02） */
export interface CheckpointIgnoreResolverOptions {
    /**
     * 默认排除类别启用状态（profileId -> boolean）。
     * 缺省（undefined）＝不启用默认类别层（恢复过滤等直接使用场景保持历史行为；
     * 快照构建器会显式传入设置解析结果）；
     * 传入 `{}` 表示全部类别按默认启用（全开，与 resolveEnabledProfiles 语义一致）；
     * 单个类别缺省按该类别默认启用处理；需要全关时显式传 `false`（前端保存完整记录）。
     */
    enabledProfiles?: Record<string, boolean>;
    /** 每类别自定义模式覆盖（profileId -> 模式清单；缺省/空数组 = 使用该类别的默认清单） */
    profilePatterns?: Record<string, string[]>;
    /** 强制排除的绝对路径（扩展存储根、存档目录等；位于工作区内时跳过整棵子树） */
    excludeAbsolutePaths?: readonly string[];
}

/** 被排除路径的记录（resolver 只能给出相对根目录的路径，调用方负责转换为 scoped） */
export interface CheckpointResolverExcludedEntry {
    /** 相对根目录的 POSIX 路径（调用方负责转换为 scoped） */
    path: string;
    reason: CheckpointExcludeReason;
    rule?: string;
    source?: string;
    /** 是否为目录（预览时用于决定是否递归统计大小） */
    isDirectory?: boolean;
}

export interface CheckpointSnapshotEntries {
    /** 需要被纳入检查点的文件绝对路径 */
    files: string[];
    /** 需要被纳入检查点的空目录绝对路径 */
    dirs: string[];
    /** 被排除路径清单（四层模型命中，EX-01；路径为相对根目录的 POSIX 格式） */
    excluded: CheckpointResolverExcludedEntry[];
}

/** 单个规则来源（用于解释“为什么被排除”） */
interface IgnoreSource {
    matcher: Ignore;
    reason: CheckpointExcludeReason;
    /** 静态来源（gitignore 路径 / custom / 兜底） */
    source: string;
    /** 动态归属：返回命中的具体规则与来源（默认类别需要动态 source=类别 id） */
    ruleOf: (candidatePath: string) => { rule?: string; source?: string } | undefined;
}

/**
 * 单个目录作用域对应的一组忽略规则。
 *
 * `basePath` 表示该 `.gitignore` 所在目录相对于根目录的位置，
 * `matcher` 保存该目录本地规则以及根级自定义/默认类别规则的匹配器。
 */
interface IgnoreScope {
    basePath: string;
    matcher: Ignore;
    /** 规则归属（顺序与 matcher 内模式顺序一致：gitignore -> profiles；custom 已拆为独立最终阶段） */
    sources: IgnoreSource[];
    /** 该作用域原始 gitignore 行（用于定位命中的具体行） */
    patternLines: string[];
}

/**
 * 检查点始终强制忽略的目录片段。
 *
 * 这些目录不依赖项目 `.gitignore` 是否显式声明，属于检查点自己的固定边界，
 * 且不能被任何 `!` 否定规则重新纳入。
 */
const FORCED_IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);

/**
 * 强制排除路径匹配是否大小写不敏感（EX-CASE-1/EX-CASE-2）。
 *
 * Windows 文件系统不区分大小写；macOS 默认 APFS 卷大小写不敏感，
 * 因此这两类平台上 `.GIT` / `NODE_MODULES` 目录片段与扩展存储绝对路径
 * 都必须按大小写折叠后比较，否则大小写变体可绕过强制排除边界。
 * Linux / 其他 POSIX 文件系统保持大小写敏感。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * 将检查点内部使用的相对路径统一为稳定格式。
 *
 * 这样做可以避免：
 * - Windows 与 POSIX 分隔符不一致
 * - 重复斜杠导致的路径比较失败
 * - `./foo` / `/foo` / `foo/` 这种等价写法干扰哈希键和匹配逻辑
 */
export function normalizeCheckpointPath(relativePath: string): string {
    return relativePath
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/$/, '');
}

/**
 * 取得一个相对路径的父目录。
 *
 * 返回空字符串表示“位于根目录作用域”。
 */
function getParentDirectory(relativePath: string): string {
    const normalized = normalizeCheckpointPath(relativePath);
    if (!normalized || !normalized.includes('/')) {
        return '';
    }
    return normalized.slice(0, normalized.lastIndexOf('/'));
}

/**
 * 判断某个候选路径是否位于给定作用域之内。
 *
 * 只有位于同一目录子树中的路径，才应该接受该 `.gitignore` 规则的影响。
 */
function isWithinScope(relativePath: string, scopeBasePath: string): boolean {
    return !scopeBasePath || relativePath === scopeBasePath || relativePath.startsWith(`${scopeBasePath}/`);
}

/**
 * 将“相对于根目录的路径”转换为“相对于某个作用域目录的路径”。
 *
 * `ignore` 库要求传入的是当前 `.gitignore` 所在目录视角下的路径，
 * 因此这里要在进入 matcher 前做一次裁剪。
 */
function toScopedPath(relativePath: string, scopeBasePath: string): string {
    if (!scopeBasePath) {
        return relativePath;
    }
    if (relativePath === scopeBasePath) {
        return '';
    }
    return relativePath.slice(scopeBasePath.length + 1);
}

/**
 * 将一个或多个规则块编译为 `ignore` matcher。
 *
 * 规则块可能来自：
 * - 当前目录的 `.gitignore`
 * - 根目录级别的自定义忽略模式
 * - 根目录级别的默认排除类别模式
 */
function createMatcher(patternBlocks: readonly string[]): Ignore | null {
    const nonEmptyBlocks = patternBlocks.filter(block => block.trim().length > 0);
    if (nonEmptyBlocks.length === 0) {
        return null;
    }

    const matcher = ignore();
    for (const block of nonEmptyBlocks) {
        matcher.add(block);
    }
    return matcher;
}

/**
 * 自定义忽略模式来自设置面板，用户可能输入 Windows 风格反斜杠。
 *
 * `ignore` 库以 POSIX 路径语义工作，因此这里只做分隔符规范化，
 * 不改写用户模式的其他含义。
 */
function normalizeExtraPattern(pattern: string): string {
    return pattern.replace(/\\/g, '/');
}

/** 行是否是可参与匹配的规则行（跳过空行与注释） */
function isUsableRuleLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
}

/** 预编译的单行规则 matcher（findMatchingRule 的缓存输入，C-5） */
interface CompiledRuleLine {
    trimmed: string;
    matcher: Ignore;
}

/**
 * 把规则行预编译为单模式 matcher 列表。
 *
 * 避免 findMatchingRule 对每个候选路径、每行规则都 new ignore() 构造 matcher——
 * 大工作区百万级实例化（C-5）；编译一次后按需复用。
 */
function compileRuleLines(patternLines: readonly string[]): CompiledRuleLine[] {
    const compiled: CompiledRuleLine[] = [];
    for (const line of patternLines) {
        const trimmed = line.trim();
        if (!isUsableRuleLine(trimmed)) {
            continue;
        }
        const single = ignore();
        single.add(trimmed);
        compiled.push({ trimmed, matcher: single });
    }
    return compiled;
}

/**
 * 在预编译规则行中查找第一个命中 candidatePath 的忽略规则。
 *
 * 用于“为什么被排除”的解释：逐行求值单模式 matcher，只返回会产生 ignore 结果的行
 * （`!` 否定行返回 unignore，自然被跳过）。
 */
function findMatchingRule(compiledLines: ReadonlyArray<CompiledRuleLine>, candidatePath: string): string | undefined {
    for (const { trimmed, matcher } of compiledLines) {
        if (matcher.test(candidatePath).ignored) {
            return trimmed;
        }
    }
    return undefined;
}

export class CheckpointIgnoreResolver {
    /** 目录作用域缓存，避免同一子树重复加载父级规则链 */
    private readonly scopeCache = new Map<string, IgnoreScope[]>();
    /** 根级自定义忽略模式，统一转换为 POSIX 路径后再参与匹配 */
    private readonly normalizedExtraPatterns: readonly string[];
    /** 自定义模式的独立 matcher（所有作用域求值之后的最终阶段，M-1） */
    private readonly customMatcher: Ignore | null;
    /** 强制排除的绝对路径（已 resolve 规范化） */
    private readonly normalizedExcludePaths: readonly string[];
    /** 启用的默认排除类别 id（按定义顺序） */
    private readonly enabledProfileIds: readonly CheckpointExclusionProfileId[];
    /** 启用的默认类别模式（扁平化，注入根作用域） */
    private readonly profilePatterns: readonly string[];
    /** 每个类别的独立 matcher（用于定位命中的具体规则） */
    private readonly profileMatchers = new Map<CheckpointExclusionProfileId, Ignore>();
    /** C-5/C-12: 每个类别「生效模式」（覆盖优先，缺省默认清单）的单行 matcher（解释与匹配同一口径） */
    private readonly profileRuleLines = new Map<CheckpointExclusionProfileId, CompiledRuleLine[]>();
    /** C-5: 用户自定义模式的单行 matcher（解释 custom 命中） */
    private readonly customRuleLines: CompiledRuleLine[];

    constructor(
        private readonly rootDir: string,
        extraPatterns: readonly string[] = [],
        options: CheckpointIgnoreResolverOptions = {}
    ) {
        this.normalizedExtraPatterns = extraPatterns.map(normalizeExtraPattern);
        this.customMatcher = this.normalizedExtraPatterns.length > 0
            ? createMatcher(this.normalizedExtraPatterns)
            : null;
        // C-5: 自定义模式解释用的单行 matcher 一次性预编译
        this.customRuleLines = compileRuleLines(this.normalizedExtraPatterns);
        this.normalizedExcludePaths = (options.excludeAbsolutePaths ?? []).map(p => path.resolve(p));
        // 缺省不启用默认类别层（保持历史行为）；快照构建器显式传入设置解析结果
        this.enabledProfileIds = options.enabledProfiles === undefined
            ? []
            : resolveEnabledProfiles(options.enabledProfiles);
        this.profilePatterns = this.enabledProfileIds.length > 0
            ? collectEnabledProfilePatterns(options.enabledProfiles, options.profilePatterns)
            : [];
        for (const profileId of this.enabledProfileIds) {
            const profile = getExclusionProfile(profileId);
            if (profile) {
                const matcher = ignore();
                const override = options.profilePatterns?.[profileId];
                const patterns = override && override.length > 0 ? override : profile.patterns;
                for (const pattern of patterns) {
                    matcher.add(pattern);
                }
                this.profileMatchers.set(profileId, matcher);
                // C-5/C-12: 解释与匹配同一口径——预编译「生效模式」（覆盖优先）的单行 matcher
                this.profileRuleLines.set(profileId, compileRuleLines(patterns));
            }
        }
    }

    /**
     * 收集当前根目录下所有需要纳入检查点的文件和空目录，以及被排除路径清单。
     *
     * 约定：
     * - 只返回“未被忽略”的路径
     * - 空目录只记录非根目录
     * - 目录一旦被忽略，整棵子树都不会继续遍历，并在 excluded 中记录该目录
     */
    async collectEntries(
        currentDir: string = this.rootDir,
        result: CheckpointSnapshotEntries = { files: [], dirs: [], excluded: [] }
    ): Promise<CheckpointSnapshotEntries> {
        const relativeDir = currentDir === this.rootDir
            ? ''
            : normalizeCheckpointPath(path.relative(this.rootDir, currentDir));
        const scopes = await this.getScopesForDirectory(relativeDir);

        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
            // M-6: 不可读目录不再静默跳过——产出 excluded 条目（预览据此置 complete=false 并统计）
            if (currentDir !== this.rootDir) {
                result.excluded.push({
                    path: normalizeCheckpointPath(path.relative(this.rootDir, currentDir)),
                    reason: 'unreadable',
                    isDirectory: true
                });
            }
            return result;
        }

        {
            let hasTrackedChildren = false;

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                const relativePath = normalizeCheckpointPath(path.relative(this.rootDir, fullPath));
                const isDirectory = entry.isDirectory();

                // 目录作用域已经在本层解析完成，下面只做纯粹的路径过滤。
                const ignoreResult = await this.shouldIgnore(relativePath, isDirectory, scopes);
                if (ignoreResult.ignored) {
                    result.excluded.push({
                        path: relativePath,
                        reason: ignoreResult.reason ?? 'forced',
                        rule: ignoreResult.rule,
                        source: ignoreResult.source,
                        isDirectory
                    });
                    continue;
                }

                hasTrackedChildren = true;

                if (isDirectory) {
                    await this.collectEntries(fullPath, result);
                } else if (entry.isFile()) {
                    result.files.push(fullPath);
                } else {
                    // CP-SYMLINK-1: 符号链接（及 fifo/socket 等特殊文件类型）不支持备份。
                    // 不再静默丢弃——记录到 excluded 清单（reason=unsupported_file_type），
                    // 预览/恢复可据此向用户解释"为什么没有备份"。
                    result.excluded.push({
                        path: relativePath,
                        reason: 'unsupported_file_type',
                        source: 'filesystem'
                    });
                }
            }

            if (!hasTrackedChildren && currentDir !== this.rootDir) {
                result.dirs.push(currentDir);
            }
        }

        return result;
    }

    /**
     * 供外部按“当前检查点规则”查询单个路径是否应该忽略。
     *
     * 这个入口让恢复逻辑不必复制任何 ignore 细节，
     * 只依赖 resolver 这一处统一语义来源。
     */
    async isIgnored(relativePath: string, isDirectory: boolean = false): Promise<boolean> {
        return (await this.shouldIgnore(relativePath, isDirectory)).ignored;
    }

    /**
     * 查询单个路径的完整忽略结果（含命中原因 / 规则 / 来源）。
     *
     * 供恢复时的规则对比（EX-11）与预览解释使用。
     */
    async checkIgnore(relativePath: string, isDirectory: boolean = false): Promise<CheckpointIgnoreResult> {
        return this.shouldIgnore(relativePath, isDirectory);
    }

    /**
     * 判断一个路径在当前规则链下是否应被忽略，并解释原因。
     *
     * 处理顺序（四层模型，EX-01）：
     * 1. 强制排除：`.git` / `node_modules` 目录片段（不可被否定）
     * 2. 强制排除：扩展存储等绝对路径（不可被否定）
     * 3. 按父到子的作用域顺序依次求值（根作用域含 .gitignore + 默认类别 + 自定义）
     * 4. 保留 `ignored` / `unignored` 的状态覆盖关系；
     *    命中后从“最后一个匹配规则”归属原因（custom > default > gitignore）
     */
    private async shouldIgnore(
        relativePath: string,
        isDirectory: boolean,
        directoryScopes?: IgnoreScope[]
    ): Promise<CheckpointIgnoreResult> {
        const normalized = normalizeCheckpointPath(relativePath);
        if (!normalized) {
            return { ignored: false };
        }

        // 第一层：强制排除（目录片段，不可被 `!` 否定；win32/darwin 大小写折叠，EX-CASE-1）
        for (const segment of normalized.split('/')) {
            const candidate = CASE_INSENSITIVE_FS ? segment.toLowerCase() : segment;
            if (FORCED_IGNORED_SEGMENTS.has(candidate)) {
                return { ignored: true, reason: 'forced', rule: segment, source: 'forced' };
            }
        }

        // 第一层：强制排除（扩展存储等绝对路径，EX-02；不可被 `!` 否定）
        if (this.normalizedExcludePaths.length > 0) {
            const absolutePath = path.join(this.rootDir, ...normalized.split('/'));
            if (isExcludedAbsolutePath(absolutePath, this.normalizedExcludePaths)) {
                return { ignored: true, reason: 'forced', rule: absolutePath, source: 'storage' };
            }
        }

        const scopes = directoryScopes ?? await this.getScopesForDirectory(getParentDirectory(normalized));
        const candidatePath = isDirectory ? `${normalized}/` : normalized;

        let ignored = false;
        // 自定义模式最终阶段是否产生决定性结果（true=忽略、false=不忽略、undefined=未命中）
        let customDecided: boolean | undefined;

        // 作用域必须按“从根到当前目录”的顺序计算，后面的规则才能正确覆盖前面。
        for (const scope of scopes) {
            if (!isWithinScope(normalized, scope.basePath)) {
                continue;
            }

            const scopedPath = toScopedPath(candidatePath, scope.basePath);
            const result = scope.matcher.test(scopedPath);

            if (result.ignored) {
                ignored = true;
            } else if (result.unignored) {
                ignored = false;
            }
        }

        // 最终阶段：用户自定义模式（M-1）。设置页规则在“所有作用域求值之后”独立执行，
        // 因此可双向覆盖任意嵌套 .gitignore / 默认类别结果（custom *.tmp + 嵌套 !keep.tmp →
        // 仍忽略；custom !keep.tmp + 嵌套 *.tmp → 不忽略），但不能覆盖强制排除。
        if (this.customMatcher) {
            const customResult = this.customMatcher.test(candidatePath);
            if (customResult.ignored) {
                ignored = true;
                customDecided = true;
            } else if (customResult.unignored) {
                ignored = false;
                customDecided = false;
            }
        }

        if (!ignored) {
            return { ignored: false };
        }

        // 归属原因：自定义最终阶段命中时优先归属 custom
        if (customDecided === true) {
            const rule = findMatchingRule(this.customRuleLines, candidatePath);
            return { ignored: true, reason: 'custom', source: 'custom', rule };
        }

        // 归属原因：从叶子作用域往根、每个作用域内从后往前，找“最后一个匹配规则”。
        // sources 顺序与 matcher 内模式顺序一致（gitignore -> profiles），
        // 因此反向遍历等价于“后写的规则优先”。
        for (let i = scopes.length - 1; i >= 0; i -= 1) {
            const scope = scopes[i];
            if (!isWithinScope(normalized, scope.basePath)) {
                continue;
            }
            const scopedPath = toScopedPath(candidatePath, scope.basePath);
            for (let j = scope.sources.length - 1; j >= 0; j -= 1) {
                const source = scope.sources[j];
                const result = source.matcher.test(scopedPath);
                if (result.ignored) {
                    const found = source.ruleOf(scopedPath);
                    return {
                        ignored: true,
                        reason: source.reason,
                        source: found?.source ?? source.source,
                        rule: found?.rule
                    };
                }
            }
        }

        return { ignored: true };
    }

    /**
     * 获取某个目录可见的完整作用域链。
     *
     * 返回值包含：
     * - 根目录的规则（.gitignore + 默认类别；自定义模式为独立最终阶段，不在此列）
     * - 沿途每一级祖先目录的 `.gitignore`
     * - 当前目录自己的 `.gitignore`
     */
    private async getScopesForDirectory(relativeDir: string): Promise<IgnoreScope[]> {
        const normalizedDir = normalizeCheckpointPath(relativeDir);
        const cacheKey = normalizedDir || '';
        const cached = this.scopeCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const parentDir = getParentDirectory(normalizedDir);
        const parentScopes = normalizedDir
            ? await this.getScopesForDirectory(parentDir)
            : [];

        const localScope = await this.loadScope(cacheKey);
        const scopes = localScope
            ? [...parentScopes, localScope]
            : parentScopes;

        this.scopeCache.set(cacheKey, scopes);
        return scopes;
    }

    /**
     * 加载某个目录自己的局部规则。
     *
     * 规则来源：
     * - 当前目录下的 `.gitignore`
     * - 根目录额外追加：默认排除类别模式（在 .gitignore 之后）
     *
     * 用户自定义模式不再注入任何作用域 matcher：它由 shouldIgnore 在全部作用域
     * 求值之后作为独立最终阶段执行（M-1，设置页规则最后生效）。
     */
    private async loadScope(relativeDir: string): Promise<IgnoreScope | null> {
        const gitignorePath = path.join(this.rootDir, relativeDir, '.gitignore');
        const patternBlocks: string[] = [];
        const patternLines: string[] = [];
        const sources: IgnoreSource[] = [];

        try {
            const content = await fs.readFile(gitignorePath, 'utf-8');
            patternBlocks.push(content);
            patternLines.push(...content.split(/\r?\n/));
        } catch {
            // 对检查点来说，“无法读取本层规则”和“本层没有规则”都等价为不追加局部 matcher。
        }

        const gitignoreMatcher = createMatcher(patternBlocks);
        // C-5: gitignore 行预编译为单行 matcher（ruleOf 解释命中规则时复用，不再逐路径逐行 new ignore()）
        const compiledGitignoreLines = compileRuleLines(patternLines);
        if (gitignoreMatcher) {
            sources.push({
                matcher: gitignoreMatcher,
                reason: 'gitignore',
                source: relativeDir ? `${normalizeCheckpointPath(relativeDir)}/.gitignore` : '.gitignore',
                ruleOf: candidate => {
                    const rule = findMatchingRule(compiledGitignoreLines, candidate);
                    return rule ? { rule } : undefined;
                }
            });
        }

        if (!relativeDir) {
            // 根作用域：默认排除类别（在 .gitignore 之后）
            if (this.profilePatterns.length > 0) {
                const profileMatcher = ignore();
                for (const pattern of this.profilePatterns) {
                    profileMatcher.add(pattern);
                }
                sources.push({
                    matcher: profileMatcher,
                    reason: 'default',
                    source: 'default',
                    ruleOf: candidate => this.findProfileMatch(candidate)
                });
                patternBlocks.push(this.profilePatterns.join('\n'));
            }

        }

        const matcher = createMatcher(patternBlocks);
        if (!matcher) {
            return null;
        }

        return {
            basePath: relativeDir,
            matcher,
            sources,
            patternLines
        };
    }

    /**
     * 在启用的默认类别中查找第一个命中 candidatePath 的类别与具体模式。
     *
     * 返回 `{ rule: 具体模式, source: 类别 id }`；未命中返回 undefined。
     */
    private findProfileMatch(candidatePath: string): { rule: string; source: string } | undefined {
        for (const profileId of this.enabledProfileIds) {
            const profileMatcher = this.profileMatchers.get(profileId);
            const profile = getExclusionProfile(profileId);
            if (!profileMatcher || !profile) {
                continue;
            }
            if (profileMatcher.test(candidatePath).ignored) {
                // C-12: 用「生效模式」（覆盖优先）解释命中，与 profileMatcher 实际匹配的模式一致
                const rule = findMatchingRule(this.profileRuleLines.get(profileId) ?? [], candidatePath);
                if (rule) {
                    return { rule, source: profileId };
                }
            }
        }
        return undefined;
    }
}
