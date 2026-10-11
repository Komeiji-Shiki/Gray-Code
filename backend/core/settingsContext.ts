/**
 * 全局上下文
 *
 * 提供全局管理器的访问点，避免循环依赖
 *
 * 包含：
 * - SettingsManager: 全局设置管理器
 * - ConfigManager: 渠道配置管理器
 */

import type { SettingsManager } from '../modules/settings';
import type { ConfigManager } from '../modules/config';

/**
 * 全局上下文接口
 */
export interface GlobalContext {
    settingsManager: SettingsManager | null;
    configManager: ConfigManager | null;
}

/**
 * 全局上下文存储
 */
const globalContext: GlobalContext = {
    settingsManager: null,
    configManager: null,
};

// ========== 设置管理器 ==========

/**
 * 设置全局设置管理器引用（失败回滚/释放时传 null 清空，见 dispose）
 */
export function setGlobalSettingsManager(manager: SettingsManager | null): void {
    globalContext.settingsManager = manager;
}

/**
 * 获取全局设置管理器
 */
export function getGlobalSettingsManager(): SettingsManager | null {
    return globalContext.settingsManager;
}

// ========== 配置管理器 ==========

/**
 * 设置全局配置管理器引用（失败回滚/释放时传 null 清空，见 dispose）
 */
export function setGlobalConfigManager(manager: ConfigManager | null): void {
    globalContext.configManager = manager;
}

/**
 * 获取全局配置管理器
 */
export function getGlobalConfigManager(): ConfigManager | null {
    return globalContext.configManager;
}

// ========== 便捷方法 ==========

/**
 * 获取完整的全局上下文
 *
 * 快照语义说明：每次调用都返回一个新的浅冻结快照（字段值与调用时刻的全局状态一致），
 * 不是全局对象的稳定引用——后续 setter 更新后，已取得的快照不会自动反映最新状态；
 * 需要最新状态时请重新调用本函数。
 */
export function getGlobalContext(): Readonly<GlobalContext> {
    // 返回浅冻结副本：调用方不能改写返回对象的内部字段，避免绕过 setter 篡改全局状态
    return Object.freeze({ ...globalContext });
}

/**
 * 初始化全局上下文
 */
export function initGlobalContext(context: Partial<GlobalContext>): void {
    if (context.settingsManager) {
        globalContext.settingsManager = context.settingsManager;
    }
    if (context.configManager) {
        globalContext.configManager = context.configManager;
    }
}

/**
 * 清除全局上下文（用于测试）
 */
export function clearGlobalContext(): void {
    globalContext.settingsManager = null;
    globalContext.configManager = null;
}