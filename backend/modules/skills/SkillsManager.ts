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
import { t, getActualLanguage } from '../../i18n';
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
    
    /** 待扫描的目录列表及来源 */
    private scanDirs: Array<{ path: string; source: SkillSource }> = [];

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
    
    constructor(options: { workspacePath?: string; globalStoragePath: string }) {
        this.legacySkillsDir = path.join(options.globalStoragePath, 'skills');
        this.buildScanDirs(options);
    }

    /**
     * 构建待扫描的目录列表
     * 按优先级排序（先扫到的优先）
     */
    private buildScanDirs(options: { workspacePath?: string; globalStoragePath: string }) {
        // 1. 项目级目录 (优先级最高)
        if (options.workspacePath) {
            this.scanDirs.push({ 
                path: path.join(options.workspacePath, '.graycode', 'skills'), 
                source: 'project-graycode' 
            });
            // fallback: 兼容旧 LimCode 项目技能目录（独立 source，避免与 graycode 目录混淆）
            this.scanDirs.push({ 
                path: path.join(options.workspacePath, '.limcode', 'skills'), 
                source: 'project-limcode' 
            });
            this.scanDirs.push({ 
                path: path.join(options.workspacePath, '.agents', 'skills'), 
                source: 'project-agents' 
            });
        }

        // 2. 用户全局目录（用户自建 skill 优先于插件 legacy 目录，防止同名被遮蔽）
        this.scanDirs.push({ 
            path: path.join(os.homedir(), '.graycode', 'skills'), 
            source: 'user-graycode' 
        });
        // fallback: 兼容旧 LimCode 用户技能目录（独立 source）
        this.scanDirs.push({ 
            path: path.join(os.homedir(), '.limcode', 'skills'), 
            source: 'user-limcode' 
        });
        this.scanDirs.push({ 
            path: path.join(os.homedir(), '.agents', 'skills'), 
            source: 'user-agents' 
        });

        // 3. Legacy 目录 (原有插件存储目录)
        this.scanDirs.push({ 
            path: this.legacySkillsDir, 
            source: 'legacy' 
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
        // 幂等合并：两次并发 initialize 复用同一个初始化任务，避免交错 refresh
        if (!this.initPromise) {
            this.initPromise = this.doInitialize().finally(() => {
                this.initPromise = null;
            });
        }
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        // 确保 legacy 目录存在（失败向上抛，不再吞错后标记 initialized）
        await this.ensureSkillsDirectory();

        // 创建示例 skill (在 legacy 目录)
        await this.createExampleSkillIfNotExists();

        // 扫描并加载所有 skills
        await this.refresh();

        this.initialized = true;
    }

    /**
     * 确保 legacy skills 目录存在（mkdir recursive 失败自然抛错）
     */
    private async ensureSkillsDirectory(): Promise<void> {
        await fs.promises.mkdir(this.legacySkillsDir, { recursive: true });
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
            
            // description 用 JSON.stringify 生成双引号 YAML 标量：
            // 含换行/引号/冒号时 frontmatter 不再错乱（parseFrontmatter 配套反转义）
            const exampleContent = `---
name: how-to-create-skill
description: ${JSON.stringify(description)}
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
     */
    async refresh(): Promise<void> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        this.refreshPromise = this.doRefresh().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }

    private async doRefresh(): Promise<void> {
        this.skills.clear();
        this.nameToId.clear();
        
        for (const dirInfo of this.scanDirs) {
            await this.scanDirectory(dirInfo.path, dirInfo.source);
        }
        
        // 基于新扫描结果重建启用状态：磁盘上已删除的 skill 不再视为启用，
        // 仍存在的 skill 保留其启用状态。
        const existingIds = new Set(this.skills.keys());
        for (const id of Array.from(this.enabledSkillIds)) {
            if (!existingIds.has(id)) {
                this.enabledSkillIds.delete(id);
            }
        }
        
        // 通知监听器
        this.notifyChange({
            type: 'refresh',
            skillIds: Array.from(this.skills.keys())
        });
    }

    /**
     * 扫描单个目录并加载 skills
     */
    private async scanDirectory(dirPath: string, source: SkillSource): Promise<void> {
        try {
            if (!fs.existsSync(dirPath)) {
                return;
            }
            
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            // 收集目录条目：符号链接用 fs.stat 跟随判断是否指向目录，
            // 否则 symlink 的 isDirectory() 恒为 false，符号链接 skill 目录永不被加载
            const dirs: Array<{ name: string; fullPath: string }> = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    dirs.push({ name: entry.name, fullPath: path.join(dirPath, entry.name) });
                } else if (entry.isSymbolicLink()) {
                    try {
                        const st = await fs.promises.stat(path.join(dirPath, entry.name));
                        if (st.isDirectory()) {
                            dirs.push({ name: entry.name, fullPath: path.join(dirPath, entry.name) });
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
                if (this.skills.has(name)) {
                    return;
                }

                const skillFile = path.join(fullPath, 'SKILL.md');
                if (!fs.existsSync(skillFile)) {
                    return;
                }
                try {
                    const skill = await this.loadSkill(name, skillFile, source);
                    if (skill) {
                        this.skills.set(skill.id, skill);
                        this.nameToId.set(skill.name, skill.id);
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
            // 剥离 UTF-8 BOM：BOM 会让 content.startsWith('---') 为 false，
            // frontmatter 完全不解析，报误导性「missing required frontmatter fields」
            const raw = await fs.promises.readFile(filePath, 'utf-8');
            const content = raw.replace(/^\uFEFF/, '');
            const { frontmatter, body } = this.parseFrontmatter(content);

            if (!frontmatter.name?.trim() || !frontmatter.description?.trim()) {
                console.warn(`[SkillsManager] Skill ${id} missing required frontmatter fields (path: ${filePath})`);
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

            const trimmedBody = body.trim();
            if (!trimmedBody) {
                // 仅有 frontmatter 无正文：可加载但告警（可能是未写完的 skill）
                console.warn(`[SkillsManager] Skill ${id} (${filePath}) has an empty body`);
            }
            
            return {
                id,
                name: frontmatter.name,
                description: frontmatter.description,
                content: trimmedBody,
                path: filePath,
                basePath: path.dirname(filePath),
                source,
                enabled: this.enabledSkillIds.has(id)
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
     */
    private unescapeQuotedValue(value: string): string {
        return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, esc: string) => {
            if (esc[0] === 'u') {
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
                default: return esc;
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
     *
     * 返回副本：enabled 统一从 enabledSkillIds 派生（唯一状态源），
     * 外部修改返回对象不会污染内部状态。
     */
    getAllSkills(): Skill[] {
        return Array.from(this.skills.values()).map(s => ({
            ...s,
            enabled: this.enabledSkillIds.has(s.id)
        }));
    }
    
    /**
     * 获取指定 skill（返回副本，enabled 从 enabledSkillIds 派生）
     */
    getSkill(id: string): Skill | undefined {
        const skill = this.skills.get(id);
        return skill ? { ...skill, enabled: this.enabledSkillIds.has(skill.id) } : undefined;
    }

    /**
     * 按名称获取 Skill (用于 read_skill 工具)
     * 注意：AI 可能在知道已禁用的情况下尝试读取，我们需要返回对象以便 read_skill 处理提示语。
     */
    getSkillByName(name: string): Skill | undefined {
        const id = this.nameToId.get(name);
        const skill = id ? this.skills.get(id) : undefined;
        return skill ? { ...skill, enabled: this.enabledSkillIds.has(skill.id) } : undefined;
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
     * 获取已启用的 skills（返回副本）
     */
    getEnabledSkills(): Skill[] {
        return Array.from(this.skills.values())
            .filter(skill => this.enabledSkillIds.has(skill.id))
            .map(s => ({ ...s, enabled: true }));
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
            
            this.notifyChange({
                type: 'disabled',
                skillIds: [id]
            });
            
            return true;
        }
        
        return false;
    }
    
    
    /**
     * 禁用所有 skills
     */
    disableAllSkills(): void {
        const disabledIds = Array.from(this.enabledSkillIds);
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
     * 释放资源
     */
    dispose(): void {
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
 * 设置全局 SkillsManager 实例（createSkillsManager 初始化完成后调用）
 */
export function setSkillsManager(manager: SkillsManager | null): void {
    globalSkillsManager = manager;
}

export async function createSkillsManager(options: {
    workspacePath?: string;
    globalStoragePath: string;
}): Promise<SkillsManager> {
    const manager = new SkillsManager(options);
    await manager.initialize();
    setSkillsManager(manager);
    return manager;
}

