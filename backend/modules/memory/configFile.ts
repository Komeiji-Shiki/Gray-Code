/**
 * GrayCode - Memory config 文件读写
 *
 * config 文件序列化/解析与原子写入。从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './types';
import { MEMORY_CONFIG_BOUNDS } from './logFormat';

/** 构造 config 文件内容（注释头 + 各配置行；与 OptMem 的 memo config 格式一致） */
export function buildConfigContent(cfg: MemoryConfig): string {
    const lines = [
        '# OptMem sizes for this memory.',
        '# Edit with memory_config NAME=VALUE.',
        '',
        `WAKE_LINES   = ${cfg.wakeLines}   # how many lines wake prints`,
        `ENTRY_CHARS  = ${cfg.entryChars}  # max bytes per memory`,
        `PART_CHARS   = ${cfg.partChars}   # max chars per output part`,
        `PART_LINES   = ${cfg.partLines}   # max lines per output part`,
        '',
    ];
    return lines.join('\n');
}

/** 解析 config 文件内容：应用默认值 + 复用 MEMORY_CONFIG_BOUNDS 钳制非法值（只钳制不抛错） */
export function parseConfigContent(content: string): MemoryConfig {
    const cfg = { ...DEFAULT_MEMORY_CONFIG };
    for (const line of content.split('\n')) {
        const trimmed = line.split('#')[0].trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim().toUpperCase();
        const val = trimmed.substring(eqIdx + 1).trim();
        if (key === 'WAKE_LINES') cfg.wakeLines = parseInt(val, 10) || cfg.wakeLines;
        if (key === 'ENTRY_CHARS') cfg.entryChars = parseInt(val, 10) || cfg.entryChars;
        if (key === 'PART_CHARS') cfg.partChars = parseInt(val, 10) || cfg.partChars;
        if (key === 'PART_LINES') cfg.partLines = parseInt(val, 10) || cfg.partLines;
    }
    // 配置文件可能被手工改出界（如 ENTRY_CHARS 超上限），未钳制会在 note/compress 的
    // pad() 处抛晦涩 Too long——与 updateConfig 的校验口径保持一致（此处只钳制不抛错）。
    for (const [key, min, max] of MEMORY_CONFIG_BOUNDS) {
        const value = cfg[key];
        if (value < min) cfg[key] = min;
        else if (value > max) cfg[key] = max;
    }
    return cfg;
}

/**
 * Windows 上 rename 到已存在目标偶发 EPERM/EEXIST（文件锁/杀软竞态）：
 * 短暂退避重试（与 BranchGraphRepository.renameWithRetry 同风格）；
 * 重试耗尽后先删旧目标再 rename（与 DiffStorageManager.atomicWriteFile 同语义）。
 */
export async function renameConfigOverwrite(tmpPath: string, configPath: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await fs.rename(tmpPath, configPath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            // 只重试「可恢复」错误码（Windows 文件锁/杀软竞态的瞬态 EPERM/EACCES/EBUSY，
            // 以及 rename 覆盖已存在目标时的 EEXIST）；其余错误立即抛出。
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
                throw error;
            }
            if (attempt >= 4) {
                // 重试耗尽：Windows 上 rename 无法覆盖已存在目标（EEXIST/EPERM）时
                // 先删旧再最后一次尝试（与 DiffStorageManager.atomicWriteFile 同语义）；
                // 其余可恢复码（EBUSY 等）原样抛出，避免删旧误伤正在被读的配置。
                if (code === 'EEXIST' || code === 'EPERM') {
                    try {
                        await fs.unlink(configPath);
                    } catch {
                        // 目标不存在或删除失败：最后一次 rename 会暴露真实错误
                    }
                    await fs.rename(tmpPath, configPath);
                    return;
                }
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 30 * attempt));
        }
    }
}

/**
 * 原子写配置：先写同目录临时文件再 rename 替换（与仓库内 saveMetadata / 分支配置
 * 同模式）。config 为全局 + 各工作区实例共享：直接 writeFile 全量覆盖在写入中途
 * 崩溃/被杀时会留下截断文件，且并发 updateConfig 的 lost-update 窗口更大；
 * tmp + 同目录 rename 是唯一提交点，崩溃时线上要么是完整旧版要么是完整新版。
 * 写入失败清理 tmp 并向上抛，调用方（updateConfig / memory_config 工具）感知失败。
 */
export async function writeConfigAtomic(configPath: string, content: string): Promise<void> {
    // 注意：tmp 文件名带 pid + 时间 + 随机后缀，避免并发实例写同一共享 config 互相覆盖 tmp
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(tmpPath, content, 'utf-8');
        await renameConfigOverwrite(tmpPath, configPath);
    } catch (error) {
        // 写入失败：清理 tmp（rename 未发生，原 config 保持完好），并向上抛
        try {
            await fs.unlink(tmpPath);
        } catch {
            // 清理失败忽略
        }
        throw error;
    }
}
