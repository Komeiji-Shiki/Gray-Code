/**
 * GrayCode - Skills 管理器
 *
 * 负责扫描、解析和管理所有 skills
 * Skills 现在支持从多个目录加载，包括项目级和用户级。
 * 不再使用拼接注入模式，AI 按需通过工具读取 Skill 内容。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { t } from '../../i18n';
import { getActualLanguage } from '../../i18n/index';
import type { Skill, SkillFrontmatter, SkillsChangeEvent, SkillsChangeListener, SkillSource } from './types';

/**
 * Skills 管理器
 *
 * 功能：
 * 1. 扫描多个 skills 目录（项目级和用户级）
 * 2. 解析 SKILL.md 文件（frontmatter + 正文），带校验
 * 3. 管理 skill 的启用/禁用状态
 * 4. 提供已启用 Skill 的摘要给 read_skill 工具
 * 5. 根据名称查找并返回 Skill 详情
 */
export class SkillsManager {
    /** 所有已加载的 skills (id -> Skill) */
    private skills: Map<string, Skill> = new Map();
    
    /** 已启用的 skill IDs */
    private enabledSkillIds: Set<string> = new Set();
    
    /** 变更监听器 */
    private listeners: Set<SkillsChangeListener> = new Set();
    
    /** 待扫描的目录列表及来源（refresh 时按最新 workspaceFolders 实时构建） */
    private scanDirs: Array<{ path: string; source: SkillSource }> = [];

    /** 构造时显式传入的工作区路径（测试/无 workspaceFolders 环境的兜底） */
    private explicitWorkspacePaths: string[] = [];

    /** vscode.workspace.onDidChangeWorkspaceFolders 订阅（initialize 时注册，dispose 释放） */
    private workspaceChangeDisposable: { dispose(): void } | null = null;

    /** Legacy 目录（存放示例技能等） */
    private legacySkillsDir: string;
    
    /** 是否已初始化 */
    private initialized: boolean = false;
    /** 进行中的初始化（幂等合并并发 initialize 调用） */
    private initPromise: Promise<void> | null = null;
    /** 进行中的 refresh（幂等合并并发 refresh 调用） */
    private refreshPromise: Promise<void> | null = null;
    /** name -> id 索引（getSkillByName 用，避免全量线性扫描） */
    private nameToId: Map<string, string> = new Map();
    
    constructor(options: { workspacePath?: string; workspacePaths?: string[]; globalStoragePath: string }) {
        this.legacySkillsDir = path.join(options.globalStoragePath, 'skills');
        this.explicitWorkspacePaths = options.workspacePath ? [options.workspacePath] : [];
        this.scanDirs = this.buildScanDirsForPaths(this.explicitWorkspacePaths);
    }

    /**
     * 当前用于扫描的工作区路径：真实 vscode 环境优先取 workspaceFolders
     * （工作区切换/增删根后即为最新，多根全部纳入）；测试环境 mock 的
     * workspaceFolders 恒为空数组，fallback 到构造时显式传入的 workspacePath。
     */
    private getWorkspacePathsForScan(): string[] {
        const folders = vscode.workspace?.workspaceFolders;
        if (Array.isArray(folders) && folders.length > 0) {
            return folders.map(folder => folder.uri.fsPath);
        }
        return this.explicitWorkspacePaths;
    }

    /**
     * 构建待扫描的目录列表（按优先级排序，先扫到的优先）。
     * 多根工作区：所有根的 .graycode/.limcode/.agents 项目目录都按 workspaceFolders 顺序加入。
     */
    private buildScanDirsForPaths(workspacePaths: string[]): Array<{ path: string; source: SkillSource }> {
        const dirs: Array<{ path: string; source: SkillSource }> = [];
        // 1. 项目级目录 (优先级最高)
        for (const workspacePath of workspacePaths) {
            if (!workspacePath) {
                continue;
            }
            dirs.push({ 
                path: path.join(workspacePath, '.graycode', 'skills'), 
                source: 'project-graycode' 
            });
            // fallback: 兼容旧 LimCode 项目技能目录（独立 source，避免与 graycode 目录混淆）
            dirs.push({ 
                path: path.join(workspacePath, '.limcode', 'skills'), 
                source: 'project-limcode' 
            });
            dirs.push({ 
                path: path.join(workspacePath, '.agents', 'skills'), 
                source: 'project-agents' 
            });
        }

        // 2. 用户全局目录（用户自建 skill 优先于插件 legacy 目录，防止同名被遮蔽）
        dirs.push({ 
            path: path.join(os.homedir(), '.graycode', 'skills'), 
            source: 'user-graycode' 
        });
        // fallback: 兼容旧 LimCode 用户技能目录（独立 source）
        dirs.push({ 
            path: path.join(os.homedir(), '.limcode', 'skills'), 
            source: 'user-graycode' 
        });
        dirs.push({ 
            path: path.join(os.homedir(), '.agents', 'skills'), 
            source: 'user-agents' 
        });

        // 3. Legacy 目录 (原有插件存储目录)
        dirs.push({ 
            path: this.legacySkillsDir, 
            source: 'legacy' 
        });

        return dirs;
    }

    /**
     * 注册 vscode.workspace.onDidChangeWorkspaceFolders 监听：工作区文件夹变更
     * （切换/增删根）时立即重建扫描目录并刷新，不依赖下一次被动 refresh。
     * 旧实现只在构造时固化 scanDirs，切换/新开工作区后项目级 skills 扫描陈旧（04 批 MEDIUM）；
     * 即使本监听不可用（测试环境 mock 无此 API），doRefresh 的实时构建仍保证扫描目录新鲜。
     */
    private registerWorkspaceFoldersListener(): void {
        if (this.workspaceChangeDisposable) {
            return; // 幂等：重复 initialize 不叠加订阅
        }
        // 运行时防御：测试环境 vscode mock 未提供此 API（类型上必然存在，mock 缺字段）
        const onDidChangeWorkspaceFolders = vscode.workspace?.onDidChangeWorkspaceFolders;
        if (typeof onDidChangeWorkspaceFolders !== 'function') {
            return;
        }
        this.workspaceChangeDisposable = onDidChangeWorkspaceFolders(() => {
            void this.refresh().catch(error => {
                console.error('[SkillsManager] Failed to refresh on workspace change:', error);
            });
        });
    }
    
    /**
     * 初始化 Skills 管理器
     *
     * 确保 Legacy 目录存在并扫描所有 skills
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        
        // 确保 legacy 目录存在
        await this.ensureSkillsDirectory();
        
        // 创建示例 skill (在 legacy 目录)
        await this.createExampleSkillIfNotExists();
        
        // 扫描并加载所有 skills
        await this.refresh();
        
        this.initialized = true;

        // 工作区文件夹变更（切换/增删根）后即时重建扫描目录并刷新（04 批 MEDIUM）
        this.registerWorkspaceFoldersListener();
    }
    
    /**
     * 确保 legacy skills 目录存在
     */
    private async ensureSkillsDirectory(): Promise<void> {
        try {
            await fs.promises.mkdir(this.legacySkillsDir, { recursive: true });
        } catch (error) {
            console.error('[SkillsManager] Failed to create legacy skills directory:', error);
        }
    }
    
    /**
     * 创建示例 skill（如果不存在）
     */
    private async createExampleSkillIfNotExists(): Promise<void> {
        // 文件夹名改为 how-to-create-skill，内容突出注意事项和常见错误
        const exampleDir = path.join(this.legacySkillsDir, 'how-to-create-skill');
        const exampleFile = path.join(exampleDir, 'SKILL.md');
        
        // 兼容旧版本：如果旧文件夹已存在，也跳过创建
        const legacyExampleDir = path.join(this.legacySkillsDir, 'example-skill', 'SKILL.md');
        const legacyChineseDir = path.join(this.legacySkillsDir, '示例技能', 'SKILL.md');        
        if (fs.existsSync(exampleFile) || fs.existsSync(legacyExampleDir) || fs.existsSync(legacyChineseDir)) {
            return;
        }
        
        try {
            await fs.promises.mkdir(exampleDir, { recursive: true });
            
            // 从 i18n 获取本地化的描述和内容
            const description = t('tools.skills.exampleSkill.description');
            const content = t('tools.skills.exampleSkill.content');
            
            const exampleContent = `---
name: how-to-create-skill
description: "${description}"
---

${content}
`;
            
            const lang = getActualLanguage();
            await fs.promises.writeFile(exampleFile, exampleContent, 'utf-8');
            console.log(`[SkillsManager] Created example skill (${lang})`);
        } catch (error) {
            console.warn('[SkillsManager] Failed to create example skill:', error);
        }
    }
    
    /**
     * 多工作区支持：运行时追加一个工作区路径的项目级扫描目录并刷新。
     *
     * 用于 VS Code 窗口内新增工作区文件夹的场景（onDidChangeWorkspaceFolders 新增分支）：
     * 不重建管理器（重建会丢失启用状态），只补扫描目录后重新扫描。
     */
    addWorkspacePath(workspacePath: string): void {
        if (!workspacePath) return;
        const candidates = [
            { path: path.join(workspacePath, '.graycode', 'skills'), source: 'project-graycode' as SkillSource },
            { path: path.join(workspacePath, '.limcode', 'skills'), source: 'project-graycode' as SkillSource },
            { path: path.join(workspacePath, '.agents', 'skills'), source: 'project-agents' as SkillSource }
        ];
        let added = false;
        for (const dirInfo of candidates) {
            if (!this.scanDirs.some((d) => d.path === dirInfo.path)) {
                this.scanDirs.push(dirInfo);
                added = true;
            }
        }
        if (added && this.initialized) {
            void this.refresh().catch((error) => {
                console.warn('[SkillsManager] Failed to refresh after adding workspace path:', error);
            });
        }
    }

    /**
     * 获取第一个用户级目录路径（用于打开目录功能）
     */
    getSkillsDirectory(): string {
        const userDir = this.scanDirs.find(d => d.source === 'user-graycode');
        return userDir ? userDir.path : this.legacySkillsDir;
    }
    
    /**
     * 刷新 skills 列表
     *
     * 重新扫描所有配置的目录并加载 skills
     * 并发保护：复用 initPromise 的串行化模式——并发 refresh 共享同一个进行中的任务，
     * 避免交错扫描导致 skills/enabledSkillIds 状态互相覆盖或重复通知监听器。
     * 合并语义复核：refresh 发起时快照扫描输入（workspaceFolders），完成时与当前快照
     * 不一致（扫描窗口内切换/增删工作区根）则再触发一轮，避免变更被合并吞掉（04 批 LOW）。
     */
    async refresh(): Promise<void> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        // 快照本轮 refresh 的扫描输入：doRefresh 用该快照构建 scanDirs（而非完成时的
        // 最新值），保证「发起时 vs 当前」比对精确——扫描期间 folders 变化才触发补扫。
        const foldersSnapshot = this.getWorkspacePathsForScan();
        this.refreshPromise = this.doRefresh(foldersSnapshot)
            .finally(() => {
                this.refreshPromise = null;
            })
            .then(
                () => this.refreshIfFoldersChanged(foldersSnapshot),
                // 失败也要比对：doRefresh 抛错时旧实现跳过补扫，扫描窗口内的工作区变更
                // 被吞掉（第五轮 LOW）。补扫完成后仍把原错误抛回给调用方——doInitialize
                // 依赖 refresh 失败上抛（不标记 initialized），工作区变更监听自行 catch。
                (error) => this.refreshIfFoldersChanged(foldersSnapshot).then(() => { throw error; })
            );
        return this.refreshPromise;
    }

    /**
     * 发起时快照与当前 workspaceFolders 一致则无事发生；不一致（扫描期间工作区
     * 切换/增删根）则再触发一轮 refresh。必须在本轮 refreshPromise 置空后调用
     * （由 refresh 链式 .then 触发，此时并发合并已结束），否则会复用进行中的任务。
     */
    private async refreshIfFoldersChanged(foldersSnapshot: string[]): Promise<void> {
        if (!this.sameWorkspacePaths(foldersSnapshot, this.getWorkspacePathsForScan())) {
            await this.refresh();
        }
    }

    /** 按顺序逐项比较两条工作区路径列表（顺序影响扫描优先级，不做排序） */
    private sameWorkspacePaths(a: string[], b: string[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    private async doRefresh(foldersSnapshot?: string[]): Promise<void> {
        // 实时构建扫描目录：任何一次 refresh 都基于发起时快照的 workspaceFolders
        // （切换/新开工作区后项目级 skills 不再陈旧；多根全部纳入，不只扫第一个根——04 批 MEDIUM）。
        // 测试环境 vscode mock 的 workspaceFolders 恒为空数组，fallback 到构造时显式路径。
        this.scanDirs = this.buildScanDirsForPaths(foldersSnapshot ?? this.getWorkspacePathsForScan());

        // 扫描期间保留旧 skills/nameToId 快照：enableSkill/disableSkill 在扫描窗口内
        // 仍作用于旧快照（不静默失败），新扫描完成后一次性原子替换（04 批 LOW）。
        const nextSkills = new Map<string, Skill>();
        const nextNameToId = new Map<string, string>();

        for (const dirInfo of this.scanDirs) {
            await this.scanDirectory(dirInfo.path, dirInfo.source, nextSkills, nextNameToId);
        }
        
        // 基于新扫描结果重建启用状态：磁盘上已删除的 skill 不再视为启用，
        // 仍存在的 skill 保留其启用状态。
        const existingIds = new Set(nextSkills.keys());
        for (const id of Array.from(this.enabledSkillIds)) {
            if (!existingIds.has(id)) {
                this.enabledSkillIds.delete(id);
            }
        }
        
        // 原子替换新快照：扫描窗口内 enableSkill/disableSkill 对旧快照的修改，
        // 若目标 skill 在新扫描中仍存在则其启用位被保留。
        this.skills = nextSkills;
        this.nameToId = nextNameToId;
        
        // 通知监听器
        this.notifyChange({
            type: 'refresh',
            skillIds: Array.from(this.skills.keys())
        });
    }

    /**
     * 扫描单个目录并加载 skills（写入 target 集合，调用方负责原子替换）
     */
    private async scanDirectory(
        dirPath: string,
        source: SkillSource,
        targetSkills: Map<string, Skill>,
        targetNameToId: Map<string, string>
    ): Promise<void> {
        try {
            if (!fs.existsSync(dirPath)) {
                return;
            }
            
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            // 收集目录条目：符号链接用 fs.stat 跟随判断是否指向目录，
            // 否则 symlink 的 isDirectory() 恒为 false，符号链接 skill 目录永不被加载。
            // 跟随符号链接目录后校验真实路径仍在扫描根内（仅接受扫描根内目标，见下），
            // 防止 symlink 逃逸扫描根（04 批 LOW；第五轮确认接受「仅扫描根内」语义）。
            const dirs: Array<{ name: string; fullPath: string }> = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    dirs.push({ name: entry.name, fullPath: path.join(dirPath, entry.name) });
                } else if (entry.isSymbolicLink()) {
                    try {
                        const fullPath = path.join(dirPath, entry.name);
                        const st = await fs.promises.stat(fullPath);
                        if (st.isDirectory()) {
                            // 符号链接逃逸防护（有意保守）：校验基准为「当前扫描目录」，
                            // 真实目标必须仍落在扫描根之内，否则 symlink 可把 skill 目录
                            // 指向扫描根外任意位置。已知副作用（第五轮确认接受现状）：
                            // 指向「工作区其他位置」但超出本扫描根的合法符号链接（如 symlink
                            // 到工作区内另一根/上级目录）同样被拒绝——语义即「仅接受扫描根
                            // 内目标」，不做跨根放行。
                            const realDir = await fs.promises.realpath(dirPath);
                            const realTarget = await fs.promises.realpath(fullPath);
                            const rel = path.relative(realDir, realTarget);
                            // 精确判逃逸（Windows 下 path.relative 返回 \\ 分隔）：仅 .. 或 ..\
                            // 前缀才算，startsWith('..') 会把扫描根内名为 ..foo 的合法目录误判
                            // 为逃逸（与 fileTree 同款修复）。
                            if (/^\.\.($|[\\/])/.test(rel) || path.isAbsolute(rel)) {
                                continue;
                            }
                            dirs.push({ name: entry.name, fullPath });
                        }
                    } catch {
                        // 悬空符号链接：跳过
                    }
                }
            }
            
            // 并发放置加载：readdir 收集后 Promise.all（同一目录内条目名唯一，
            // has 检查 + set 无竞态；跨目录优先级由外层 scanDirs 串行顺序保证）
            await Promise.all(dirs.map(async ({ name, fullPath }) => {
                // 如果已存在同名 Skill (id 相同)，由于 scanDirs 顺序决定了优先级，后扫到的跳过
                if (targetSkills.has(name)) {
                    return;
                }

                const skillFile = path.join(fullPath, 'SKILL.md');
                if (!fs.existsSync(skillFile)) {
                    return;
                }
                try {
                    const skill = await this.loadSkill(name, skillFile, source);
                    if (skill) {
                        targetSkills.set(skill.id, skill);
                        targetNameToId.set(skill.name, skill.id);
                    }
                } catch (error) {
                    console.warn(`[SkillsManager] Failed to load skill ${name} from ${source}:`, error);
                }
            }));
        } catch (error) {
            console.error(`[SkillsManager] Failed to scan directory ${dirPath}:`, error);
        }
    }
    
    /**
     * Skill ID 合法性校验规则（与 loadSkill 内联校验保持一致）。
     *
     * 规则：
     * - 1-64 个字符
     * - 仅允许小写字母、数字和连字符
     * - 不能以连字符开头或结尾
     * - 不能包含连续连字符
     *
     * @returns 合法返回 true，非法返回 false
     */
    static validateSkillId(id: string): boolean {
        if (!id || typeof id !== 'string') return false;
        if (id.length < 1 || id.length > 64) return false;
        if (id.startsWith('-') || id.endsWith('-')) return false;
        if (id.includes('--')) return false;
        return /^[a-z0-9-]+$/.test(id);
    }

    /**
     * 加载单个 skill
     *
     * @param id Skill ID（文件夹名称）
     * @param filePath SKILL.md 文件路径
     * @param source 来源
     */
    private async loadSkill(id: string, filePath: string, source: SkillSource): Promise<Skill | null> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const { frontmatter, body } = this.parseFrontmatter(content);

            if (!frontmatter.name || !frontmatter.description) {
                console.warn(`[SkillsManager] Skill ${id} missing required frontmatter fields`);
                return null;
            }

            // 新增：frontmatter 中的 name 必须与 id (文件夹名) 一致
            if (frontmatter.name !== id) {
                console.warn(`[SkillsManager] Skill ${id} name mismatch: frontmatter name "${frontmatter.name}" does not match folder name "${id}". Skipping.`);
                return null;
            }

            // 新增：name 格式校验（复用统一的校验函数）
            if (!SkillsManager.validateSkillId(frontmatter.name)) {
                console.warn(`[SkillsManager] Skill ${id} name "${frontmatter.name}" is invalid. Must be 1-64 chars, lowercase, digits, and hyphens only, no consecutive hyphens. Skipping.`);
                return null;
            }
            
            return {
                id,
                name: frontmatter.name,
                description: frontmatter.description,
                content: body.trim(),
                path: filePath,
                basePath: path.dirname(filePath),
                source,
                enabled: this.enabledSkillIds.has(id),
                sendContent: false // Deprecated 模式下不再使用拼接
            };
        } catch (error) {
            console.error(`[SkillsManager] Failed to load skill ${id}:`, error);
            return null;
        }
    }
    
    /**
     * 定位 frontmatter 结束标记（独占一行的 '---'）的字符索引，找不到返回 -1。
     * 只用 indexOf 找 '---' 会把 description 等字段内容里的 '---' 误判为结束，
     * 导致 frontmatter 提前截断、正文错乱。
     */
    private findFrontmatterEnd(content: string): number {
        const lines = content.split('\n');
        // 第 0 行是开头的 '---'，从其后开始找
        let offset = lines[0].length + 1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                return offset;
            }
            offset += lines[i].length + 1;
        }
        return -1;
    }
    
    /**
     * 反转 JSON 双引号字符串转义（\n \r \t \" \\ \uXXXX 等），
     * 与 SettingsExporter.buildSkillMarkdown 的 JSON.stringify 输出配套，保证往返一致。
     *
     * 误判修复：\u 后随非 4 位十六进制（如 \update、\user、Windows 路径 C:\Users）时，
     * 旧实现只判断 esc[0] === 'u' 即走 unicode 分支，parseInt('',16)=NaN →
     * String.fromCharCode(NaN) 产生 NUL 字符；单反斜杠（\U）也被直接剥掉。
     * 现改为先校验完整转义形态 /^u[0-9a-fA-F]{4}$/ 才做 unicode 解码，否则保留
     * 字面反斜杠 + 原文；双反斜杠 \\ 仍解为单个 \。
     */
    private unescapeQuotedValue(value: string): string {
        return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, esc: string) => {
            // 仅完整 \uXXXX（4 位十六进制）形态才做 unicode 解码，避免误判
            if (/^u[0-9a-fA-F]{4}$/.test(esc)) {
                return String.fromCharCode(parseInt(esc.substring(1), 16));
            }
            switch (esc) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case 'b': return '\b';
                case 'f': return '\f';
                case '"': return '"';
                case '\\': return '\\';
                case '/': return '/';
                default: return '\\' + esc; // 未知转义保留字面反斜杠 + 原文
            }
        });
    }
    
    /**
     * 解析 frontmatter
     */
    private parseFrontmatter(content: string): { frontmatter: Partial<SkillFrontmatter>; body: string } {
        const frontmatter: Partial<SkillFrontmatter> = {};
        let body = content;
        
        if (content.startsWith('---')) {
            const endIndex = this.findFrontmatterEnd(content);
            if (endIndex !== -1) {
                const frontmatterContent = content.substring(3, endIndex).trim();
                body = content.substring(endIndex + 3).trim();
                
                const lines = frontmatterContent.split('\n');
                for (const line of lines) {
                    const colonIndex = line.indexOf(':');
                    if (colonIndex !== -1) {
                        const key = line.substring(0, colonIndex).trim();
                        let value = line.substring(colonIndex + 1).trim();
                        
                        if (value.startsWith('"') && value.endsWith('"')) {
                            // 双引号标量：反转义（与 SettingsExporter 导出的 JSON.stringify 输出配套）
                            value = this.unescapeQuotedValue(value.slice(1, -1));
                        } else if (value.startsWith("'") && value.endsWith("'")) {
                            value = value.slice(1, -1);
                        }
                        
                        if (key === 'name') {
                            frontmatter.name = value;
                        } else if (key === 'description') {
                            frontmatter.description = value;
                        }
                    }
                }
            }
        }
        
        return { frontmatter, body };
    }
    
    /**
     * 获取所有已加载的 skills
     */
    getAllSkills(): Skill[] {
        return Array.from(this.skills.values());
    }
    
    /**
     * 获取指定 skill
     */
    getSkill(id: string): Skill | undefined {
        return this.skills.get(id);
    }

    /**
     * 按名称获取 Skill (用于 read_skill 工具)
     * 注意：AI 可能在知道已禁用的情况下尝试读取，我们需要返回对象以便 read_skill 处理提示语。
     */
    getSkillByName(name: string): Skill | undefined {
        return Array.from(this.skills.values()).find(s => s.name === name);
    }

    /**
     * 获取所有已启用 Skill 的摘要信息
     */
    getSkillSummaries(): Array<{ name: string; description: string }> {
        return this.getEnabledSkills().map(s => ({ 
            name: s.name, 
            description: s.description 
        }));
    }
    
    /**
     * 获取已启用的 skills
     */
    getEnabledSkills(): Skill[] {
        return Array.from(this.skills.values()).filter(skill => this.enabledSkillIds.has(skill.id));
    }
    
    /**
     * 检查 skill 是否启用
     */
    isSkillEnabled(id: string): boolean {
        return this.enabledSkillIds.has(id);
    }
    
    /**
     * 启用 skill
     */
    enableSkill(id: string): boolean {
        if (!this.skills.has(id)) {
            return false;
        }
        
        if (!this.enabledSkillIds.has(id)) {
            this.enabledSkillIds.add(id);
            
            const skill = this.skills.get(id);
            if (skill) {
                skill.enabled = true;
            }
            
            this.notifyChange({
                type: 'enabled',
                skillIds: [id]
            });
        }
        
        return true;
    }
    
    /**
     * 禁用 skill
     */
    disableSkill(id: string): boolean {
        if (this.enabledSkillIds.has(id)) {
            this.enabledSkillIds.delete(id);
            
            const skill = this.skills.get(id);
            if (skill) {
                skill.enabled = false;
            }
            
            this.notifyChange({
                type: 'disabled',
                skillIds: [id]
            });
            
            return true;
        }
        
        return false;
    }
    
    /**
     * 批量设置 skills 状态
     */
    setSkillsState(skillStates: Record<string, boolean>): void {
        const changedIds: string[] = [];
        
        for (const [id, enabled] of Object.entries(skillStates)) {
            if (!this.skills.has(id)) {
                continue;
            }
            
            const currentlyEnabled = this.enabledSkillIds.has(id);
            
            if (enabled && !currentlyEnabled) {
                this.enabledSkillIds.add(id);
                const skill = this.skills.get(id);
                if (skill) skill.enabled = true;
                changedIds.push(id);
            } else if (!enabled && currentlyEnabled) {
                this.enabledSkillIds.delete(id);
                const skill = this.skills.get(id);
                if (skill) skill.enabled = false;
                changedIds.push(id);
            }
        }
        
        if (changedIds.length > 0) {
            this.notifyChange({ type: 'update', skillIds: changedIds });
        }
    }
    
    /**
     * 禁用所有 skills
     */
    disableAllSkills(): void {
        const disabledIds = Array.from(this.enabledSkillIds);
        
        for (const id of disabledIds) {
            const skill = this.skills.get(id);
            if (skill) {
                skill.enabled = false;
            }
        }
        
        this.enabledSkillIds.clear();
        
        if (disabledIds.length > 0) {
            this.notifyChange({ type: 'disabled', skillIds: disabledIds });
        }
    }
    
    /**
     * 添加变更监听器
     */
    addChangeListener(listener: SkillsChangeListener): void {
        this.listeners.add(listener);
    }
    
    /**
     * 移除变更监听器
     */
    removeChangeListener(listener: SkillsChangeListener): void {
        this.listeners.delete(listener);
    }
    
    /**
     * 通知变更
     */
    private notifyChange(event: SkillsChangeEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('[SkillsManager] Listener error:', error);
            }
        }
    }
    
    /**
     * 获取 skills 数量
     */
    getSkillsCount(): number {
        return this.skills.size;
    }
    
    /**
     * 获取启用的 skills 数量
     */
    getEnabledSkillsCount(): number {
        return this.enabledSkillIds.size;
    }
    
    /**
     * 释放资源
     */
    dispose(): void {
        this.workspaceChangeDisposable?.dispose();
        this.workspaceChangeDisposable = null;
        this.listeners.clear();
    }
}

// 全局实例
let globalSkillsManager: SkillsManager | null = null;

/**
 * 获取全局 SkillsManager 实例
 */
export function getSkillsManager(): SkillsManager | null {
    return globalSkillsManager;
}

/**
 * 设置全局 SkillsManager 实例
 */
export function setSkillsManager(manager: SkillsManager): void {
    globalSkillsManager = manager;
}

/**
 * 创建并初始化 SkillsManager
 *
 * @param options 初始化选项，包含工作区路径和全局存储路径
 */
export async function createSkillsManager(options: {
    workspacePath?: string;
    workspacePaths?: string[];
    globalStoragePath: string;
}): Promise<SkillsManager> {
    const manager = new SkillsManager(options);
    await manager.initialize();
    setSkillsManager(manager);
    return manager;
}

