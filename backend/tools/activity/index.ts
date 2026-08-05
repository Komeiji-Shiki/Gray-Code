import type { Tool, ToolRegistration } from '../types';

export {
    createGetActivityStatsTool,
    createGetActivityStatsToolDeclaration,
    registerGetActivityStats
} from './activity_stats';

export function getActivityToolRegistrations(): ToolRegistration[] {
    const { registerGetActivityStats } = require('./activity_stats');
    return [registerGetActivityStats];
}

export function getAllActivityTools(): Tool[] {
    const { registerGetActivityStats } = require('./activity_stats');
    return [registerGetActivityStats()];
}
