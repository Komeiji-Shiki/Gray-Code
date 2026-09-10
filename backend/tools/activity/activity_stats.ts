/** 原活动工具使用编辑器采样，独立宿主注入自己的统计来源。 */
import type { Tool } from '../types';
import { getActivityStats, getGlobalActivityTracker } from '../../modules/activity';
import { createActivityStatsTool } from './activityRuntime';
export { createGetActivityStatsToolDeclaration } from './activityRuntime';
export function createGetActivityStatsTool(): Tool {
    return createActivityStatsTool(async query => {
        const tracker = getGlobalActivityTracker();
        if (!tracker) throw new Error('Activity tracker is not initialized.');
        return getActivityStats(tracker.getStore(), query);
    });
}
export function registerGetActivityStats(): Tool { return createGetActivityStatsTool(); }
