/**
 * LimCode - 设置存储实现
 * 
 * 提供基于文件系统的设置持久化
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SettingsStorage } from './SettingsManager';
import type { GlobalSettings } from './types';

/**
 * 文件存储实现
 * 
 * 将设置保存为 JSON 文件
 */
export class FileSettingsStorage implements SettingsStorage {
    private filePath: string;
    
    /**
     * @param storageDir 存储目录路径
     * @param filename 文件名（默认 'settings.json'）
     */
    constructor(storageDir: string, filename: string = 'settings.json') {
        this.filePath = path.join(storageDir, filename);
    }
    
    /**
     * 加载设置
     */
    async load(): Promise<GlobalSettings | null> {
        try {
            const content = await fs.readFile(this.filePath, 'utf-8');
            return JSON.parse(content);
        } catch (error: any) {
            // 文件不存在：按全新安装处理
            if (error.code === 'ENOENT') {
                return null;
            }
            // 解析失败（或读取异常）：抛错而不是静默归零，
            // 避免设置管理器按全新安装处理并在下次保存时覆盖可恢复的坏文件。
            throw new Error(`Failed to load settings from ${this.filePath}: ${error.message}`);
        }
    }
    
    /**
     * 保存设置
     *
     * 原子写：先写同目录临时文件再 rename 覆盖——直接 writeFile 线上文件在进程崩溃时
     * 会留下半截 JSON（load 抛错，设置整体不可用）。生产走 VSCodeSettingsStorage，
     * 本实现用于 legacy/测试路径，同样保证崩溃安全性。
     */
    async save(settings: GlobalSettings): Promise<void> {
        try {
            // 确保目录存在
            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });
            
            // 格式化 JSON（缩进 2 空格）
            const content = JSON.stringify(settings, null, 2);
            // 原子写：tmp 名带随机后缀，避免并发 save 写同一 tmp 互相踩（固定名会让
            // 两个 writeFile 交错写同一路径，最终 rename 出混合内容）
            const tmpPath = `${this.filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await fs.writeFile(tmpPath, content, 'utf-8');
            try {
                await fs.rename(tmpPath, this.filePath);
            } catch (renameError) {
                // 清理残留 tmp（rename 失败如 Windows EPERM 时），不让半成品堆积
                await fs.unlink(tmpPath).catch(() => undefined);
                throw renameError;
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
            throw error;
        }
    }
}

/**
 * 内存存储实现
 * 
 * 仅用于测试或临时使用
 */
export class MemorySettingsStorage implements SettingsStorage {
    private settings: GlobalSettings | null = null;
    
    async load(): Promise<GlobalSettings | null> {
        // 深拷贝返回：浅展开只保护顶层，嵌套对象（toolsConfig 等）仍是活引用，
        // 调用方原地修改会污染内存中的存储状态
        return this.settings ? structuredClone(this.settings) : null;
    }
    
    async save(settings: GlobalSettings): Promise<void> {
        // 深拷贝保存：与调用方对象解耦，后续原地修改不会影响已保存的状态
        this.settings = structuredClone(settings);
    }
}