/**
 * GrayCode - get_activity_stats 工具
 *
 * 让 AI 查看用户的 IDE 使用时间统计：
 * - 每日使用时长（分钟）与会话数
 * - 最近作息（24 小时热力，可选用）
 * - 当前连续工作时长
 *
 * 数据来自 ActivityTracker 的活跃采样（心跳 + 用户活动事件），
 * 只含时间戳，不含任何用户内容。
 */

import type { Tool, ToolDeclaration, ToolResult } from '../types';
import {
    getActivityStats,
    getGlobalActivityTracker,
    type ActivityStatsResult,
    type ActivityTracker
} from '../../modules/activity';

const RANGES = ['today', '7d', '30d', '90d', '365d', 'all'] as const;
type ActivityRange = (typeof RANGES)[number];

function isRange(value: unknown): value is ActivityRange {
    return typeof value === 'string' && (RANGES as readonly string[]).includes(value);
}

/** 时间戳 → 本地可读字符串（HH:mm 或 YYYY-MM-DD HH:mm） */
function formatTime(t: number, withDate = false): string {
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (!withDate) return `${hh}:${mm}`;
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day} ${hh}:${mm}`;
}

/** 把聚合结果加工成 AI 友好的展示结构（时间戳 → 本地时间字符串） */
function toReadableResult(result: ActivityStatsResult): Record<string, unknown> {
    return {
        generatedAt: formatTime(result.generatedAt, true),
        today: result.today
            ? {
                date: result.today.date,
                totalMinutes: result.today.totalMinutes,
                sessionCount: result.today.sessionCount,
                firstActiveAt: result.today.firstActiveAt !== null ? formatTime(result.today.firstActiveAt) : null,
                lastActiveAt: result.today.lastActiveAt !== null ? formatTime(result.today.lastActiveAt) : null
            }
            : null,
        currentSession: {
            active: result.currentSession.active,
            startedAt: result.currentSession.startedAt !== null ? formatTime(result.currentSession.startedAt) : null,
            minutes: result.currentSession.minutes
        },
        daily: result.daily.map((d) => ({
            date: d.date,
            totalMinutes: d.totalMinutes,
            sessionCount: d.sessionCount,
            firstActiveAt: d.firstActiveAt !== null ? formatTime(d.firstActiveAt) : null,
            lastActiveAt: d.lastActiveAt !== null ? formatTime(d.lastActiveAt) : null
        })),
        monthly: result.monthly.map((m) => ({
            month: m.month,
            totalMinutes: m.totalMinutes,
            activeDays: m.activeDays,
            sessionCount: m.sessionCount
        })),
        hourlyHeatmap: result.hourlyHeatmap
    };
}

export function createGetActivityStatsToolDeclaration(): ToolDeclaration {
    return {
        name: 'get_activity_stats',
        strict: true,
        readOnly: true,
        category: 'activity',
        description: 'Get the user\'s IDE usage time statistics: daily usage minutes, recent schedule (hourly heatmap of when the user is active), and how long the user has been continuously working. Use this to understand the user\'s work-rest rhythm, detect long continuous working sessions, or check whether the user is currently active. Data contains timestamps only, no user content. Returned times are in local time (HH:mm, YYYY-MM-DD).',
        parameters: {
            type: 'object',
            properties: {
                range: {
                    type: 'string',
                    enum: [...RANGES],
                    description: 'Statistics range: today / 7d (last 7 days) / 30d / 90d / 365d / all (entire history). Default: 7d.'
                },
                includeHourly: {
                    type: 'boolean',
                    description: 'Whether to include the hourly heatmap (24 slots per day, active minutes per hour, local time). Useful for analyzing the user\'s sleep/work schedule. Default: false.'
                },
                includeMonthly: {
                    type: 'boolean',
                    description: 'Whether to include monthly aggregates (total minutes, active days, session count per month). Useful for long-term usage overview. Default: false.'
                }
            }
        }
    };
}

export function createGetActivityStatsTool(): Tool {
    return {
        declaration: createGetActivityStatsToolDeclaration(),
        handler: async (args): Promise<ToolResult> => {
            const tracker = getGlobalActivityTracker();
            if (!tracker) {
                return {
                    success: false,
                    error: 'Activity tracker is not initialized. Usage time statistics are unavailable before the extension backend is ready.'
                };
            }

            const range = isRange(args?.range) ? args.range : '7d';
            const includeHourly = args?.includeHourly === true;
            const includeMonthly = args?.includeMonthly === true;

            try {
                const result = await getActivityStatsSafe(tracker, range, includeHourly, includeMonthly);
                return {
                    success: true,
                    data: toReadableResult(result)
                };
            } catch (error: any) {
                return {
                    success: false,
                    error: `Failed to load activity stats: ${error?.message || String(error)}`
                };
            }
        }
    };
}

async function getActivityStatsSafe(
    tracker: ActivityTracker,
    range: ActivityRange,
    includeHourly: boolean,
    includeMonthly: boolean
): Promise<ActivityStatsResult> {
    return await getActivityStats(tracker.getStore(), { range, includeHourly, includeMonthly });
}

export function registerGetActivityStats(): Tool {
    return createGetActivityStatsTool();
}
