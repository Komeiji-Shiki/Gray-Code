import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import type { ActivitySession, ActivityStatsResult, ActivityStatsQuery } from '../../modules/activity/types';

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

/** 一段区间 → 本地时间字符串：两端同一天为 "HH:mm-HH:mm"，跨日则两端补日期 */
function formatRange(start: number, end: number): string {
    const s = new Date(start);
    const e = new Date(end);
    const sameDay = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()
        && s.getDate() === e.getDate();
    return sameDay
        ? `${formatTime(start)}-${formatTime(end)}`
        : `${formatTime(start, true)}-${formatTime(end, true)}`;
}

/**
 * 会话明细只给最近 SESSION_DETAIL_DAYS 天。
 * 长范围（365d / all）逐日铺开每段会话会让响应膨胀几十倍，而判断作息只需要最近几天的具体时段，
 * 更早的日期保留每日聚合值即可。
 */
const SESSION_DETAIL_DAYS = 7;

/** 单日最多列出的时段数，超出的用 sessionsOmitted 记录省略条数 */
const MAX_SESSIONS_PER_DAY = 24;

interface DaySessionDetail {
    /** 该日各段工作时段，形如 "10:00-10:02 (2m)" */
    sessions?: string[];
    /** 被省略的时段数（仅当超过 MAX_SESSIONS_PER_DAY 时出现） */
    sessionsOmitted?: number;
    /** 相邻时段之间的空档（仅最近一天给出）：用户离开编辑器的时间 */
    gaps?: string[];
}

/**
 * 组装单日会话明细。
 * - includeDetail=false（早于明细窗口的日期）：不返回任何字段，只有每日聚合值；
 * - includeGaps=true（最近一天）：附带空档列表——空档正是「用户中途离开 / 睡觉」的直接证据，
 *   单看 firstActiveAt 与 lastActiveAt 会把全天读成一段连续工作。
 */
function daySessionDetail(sessions: ActivitySession[], includeDetail: boolean, includeGaps: boolean): DaySessionDetail {
    if (!includeDetail) return {};
    const shown = sessions.slice(0, MAX_SESSIONS_PER_DAY);
    const detail: DaySessionDetail = {
        sessions: shown.map((s) => `${formatRange(s.start, s.end)} (${s.minutes}m)`)
    };
    if (sessions.length > shown.length) {
        detail.sessionsOmitted = sessions.length - shown.length;
    }
    if (includeGaps) {
        detail.gaps = sessions.slice(1).map((s, i) => {
            const previous = sessions[i];
            return `${formatRange(previous.end, s.start)} (${Math.round((s.start - previous.end) / 60_000)}m)`;
        });
    }
    return detail;
}

/** 把聚合结果加工成 AI 友好的展示结构（时间戳 → 本地时间字符串） */
function toReadableResult(result: ActivityStatsResult): Record<string, unknown> {
    // daily 按日期倒序（最新在前）：索引 0 是最近一天，只有它附带 gaps
    const daily = result.daily.map((d, index) => ({
        date: d.date,
        totalMinutes: d.totalMinutes,
        sessionCount: d.sessionCount,
        firstActiveAt: d.firstActiveAt !== null ? formatTime(d.firstActiveAt) : null,
        lastActiveAt: d.lastActiveAt !== null ? formatTime(d.lastActiveAt) : null,
        ...daySessionDetail(d.sessions, index < SESSION_DETAIL_DAYS, index === 0)
    }));
    const todayDate = result.today?.date ?? null;

    return {
        generatedAt: formatTime(result.generatedAt, true),
        today: todayDate !== null ? daily.find((d) => d.date === todayDate) ?? null : null,
        currentSession: {
            active: result.currentSession.active,
            // 会话可能从昨天延续（跨午夜），带上日期避免被读成今天的时间
            startedAt: result.currentSession.startedAt !== null
                ? formatTime(result.currentSession.startedAt, true)
                : null,
            minutes: result.currentSession.minutes
        },
        daily,
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
        description: 'Get statistics on how the user spends time in the IDE: how long they have worked, in which blocks, and how long the current stretch has lasted. Use it to understand the user\'s work and rest rhythm, spot long unbroken sessions, or check whether the user is active right now.\n\nActivity is recorded as separate sessions: 15 or more minutes without activity ends a session, and the next activity starts a new one. A gap therefore means the user left the IDE (a break, sleep or time away), so do not assume they worked continuously from firstActiveAt to lastActiveAt. "sessions" covers the last 7 days and lists each day\'s actual work blocks as local "HH:mm-HH:mm (Nm)"; "gaps" covers the most recent day and lists the idle intervals between blocks; "currentSession.startedAt" is when the ongoing session began, including the date because a session can start before midnight. The data holds timestamps only, with no user content, and all times are local (HH:mm or YYYY-MM-DD HH:mm).',
        parameters: {
            type: 'object',
            properties: {
                range: {
                    type: 'string',
                    enum: [...RANGES],
                    description: 'Time range: today, 7d (last 7 days), 30d, 90d, 365d or all (entire history); default 7d.'
                },
                includeHourly: {
                    type: 'boolean',
                    description: 'Whether to include an hourly heatmap (24 slots per day with active minutes per hour, local time), which helps when analyzing the user\'s sleep and work schedule; default false.'
                },
                includeMonthly: {
                    type: 'boolean',
                    description: 'Whether to include monthly totals (minutes, active days and session count per month) for a long-term overview; default false.'
                }
            }
        }
    };
}

export function createActivityStatsTool(stats: (query: ActivityStatsQuery, context?: ToolContext) => Promise<ActivityStatsResult>): Tool {
    return {
        declaration: createGetActivityStatsToolDeclaration(),
        handler: async (args, context): Promise<ToolResult> => {
            const range = isRange(args?.range) ? args.range : '7d';
            const includeHourly = args?.includeHourly === true;
            const includeMonthly = args?.includeMonthly === true;

            try {
                const result = await stats({ range, includeHourly, includeMonthly }, context);
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
