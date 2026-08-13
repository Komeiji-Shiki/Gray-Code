/**
 * 上下文管理策略解析（纯函数模块，从 ContextTrimService 抽离）。
 *
 * 依据渠道配置推导本轮上下文管理开关与模式：
 * - 显式 contextManagementEnabled 为权威入口（统一走模型总结优先）
 * - 否则回退到旧字段 autoSummarizeEnabled / contextThresholdEnabled 推导
 */

import type { BaseChannelConfig } from '../../../../config/configs/base';

export interface ContextManagementPolicy {
    enabled: boolean;
    mode: 'trim' | 'summarize';
    source: 'explicit' | 'legacy';
}

export function resolveContextManagementPolicy(config: BaseChannelConfig): ContextManagementPolicy {
    if (typeof config.contextManagementEnabled === 'boolean') {
        return {
            enabled: config.contextManagementEnabled,
            // 直接按用户回合裁剪会无损失提示地抹掉大段历史。统一改为模型总结优先；
            // 原 trim 配置保留为兼容输入，只有总结失败时才走临时细粒度裁剪。
            mode: 'summarize',
            source: 'explicit'
        };
    }

    if (config.autoSummarizeEnabled || config.contextThresholdEnabled) {
        return { enabled: true, mode: 'summarize', source: 'legacy' };
    }

    return { enabled: false, mode: 'trim', source: 'legacy' };
}
