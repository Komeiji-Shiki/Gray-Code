import type { ToolRegistration } from '../types';

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerGetActivityStats } from './activity_stats';

export {
    createGetActivityStatsTool,
    createGetActivityStatsToolDeclaration,
    registerGetActivityStats
} from './activity_stats';

export function getActivityToolRegistrations(): ToolRegistration[] {
    return [registerGetActivityStats];
}
