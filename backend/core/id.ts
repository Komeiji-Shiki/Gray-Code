/**
 * ID 生成工具（模块化重构第六批收敛）。
 *
 * 收敛前：randomUUID() 散落于 BranchService / CheckpointManifestRepository /
 * agentMailbox 等处；ConfigManager 另用 randomBytes(16).toString('hex')
 * （32 位十六进制，不同格式）。本文件统一提供两种生成器，
 * 输出格式与收敛前完全一致（行为零变化）。
 */

import { randomBytes, randomUUID } from 'node:crypto';

/** 生成标准 UUID v4（crypto.randomUUID 包装；消息/节点/信箱消息 ID 等） */
export function newUuid(): string {
    return randomUUID();
}

/** 生成 32 位十六进制 ID（randomBytes(16).toString('hex') 包装；ConfigManager 配置 ID 格式） */
export function newHexId(): string {
    return randomBytes(16).toString('hex');
}
