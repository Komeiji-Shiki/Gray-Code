/**
 * 思考强度快速切换工具
 *
 * 聊天输入区「思考强度」下拉框使用统一的 Off / Low / Medium / High 四级，
 * 映射到各渠道已有的 thinking / reasoning 配置字段——与设置页写入的是同一份数据，
 * 下拉框的选择会直接反映到设置页（反之亦然）。
 *
 * 映射口径：
 * - openai / openai-responses: options.reasoning.effort（闸门 optionsEnabled.reasoning）
 * - anthropic: options.thinking.type + effort（闸门 optionsEnabled.thinking）
 * - gemini: options.thinkingConfig.mode + thinkingLevel（闸门 optionsEnabled.thinkingConfig）
 *
 * 选项文案刻意保持英文（Off/Low/Medium/High）不做 i18n 翻译，
 * 便于用户直接对应各 API 的 effort / thinkingLevel 取值。
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

const OPENAI_THINKING_TYPES = new Set(['openai', 'openai-responses'])
const ANTHROPIC_THINKING_TYPES = new Set(['anthropic'])
const GEMINI_THINKING_TYPES = new Set(['gemini'])

/** OpenAI 系 effort → 四级档位（xhigh/max/ultra/custom 统一归 high，none 即 off） */
const OPENAI_EFFORT_RANK: Record<string, ThinkingLevel> = {
  none: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  ultra: 'high',
  custom: 'high'
}

/** Anthropic effort → 四级档位（ultra/max/xhigh/custom 统一归 high） */
const ANTHROPIC_EFFORT_RANK: Record<string, ThinkingLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  ultra: 'high',
  custom: 'high'
}

/** Gemini thinkingLevel → 四级档位（minimal 归 low） */
const GEMINI_LEVEL_RANK: Record<string, ThinkingLevel> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high'
}

/** 渠道类型是否支持思考强度快捷控制 */
export function supportsThinkingLevel(config: any): boolean {
  if (!config || typeof config !== 'object') return false
  const type = typeof config.type === 'string' ? config.type : ''
  return OPENAI_THINKING_TYPES.has(type) || ANTHROPIC_THINKING_TYPES.has(type) || GEMINI_THINKING_TYPES.has(type)
}

/**
 * 读取当前渠道配置对应的思考强度档位。
 *
 * 闸门语义与设置页一致：openai/anthropic 默认关闭（未开启视为 Off），
 * gemini 默认开启（thinkingConfig 默认思考）。
 */
export function getThinkingLevel(config: any): ThinkingLevel {
  if (!supportsThinkingLevel(config)) return 'off'
  const type: string = config.type
  const options = config.options || {}
  const optionsEnabled = config.optionsEnabled || {}

  if (OPENAI_THINKING_TYPES.has(type)) {
    if (!optionsEnabled.reasoning) return 'off'
    const effort = options.reasoning?.effort
    if (!effort) return 'high'
    return OPENAI_EFFORT_RANK[effort] ?? 'high'
  }

  if (ANTHROPIC_THINKING_TYPES.has(type)) {
    if (!optionsEnabled.thinking) return 'off'
    const thinking = options.thinking || {}
    if (thinking.type === 'disabled') return 'off'
    const effort = thinking.effort || 'high'
    return ANTHROPIC_EFFORT_RANK[effort] ?? 'high'
  }

  if (GEMINI_THINKING_TYPES.has(type)) {
    if (optionsEnabled.thinkingConfig === false) return 'off'
    const thinkingConfig = options.thinkingConfig || {}
    if (thinkingConfig.includeThoughts === false) return 'off'
    if (thinkingConfig.mode === 'level') {
      return GEMINI_LEVEL_RANK[thinkingConfig.thinkingLevel] ?? 'medium'
    }
    // default / budget 模式：使用 API 默认思考强度（按中档展示）
    return 'medium'
  }

  return 'off'
}

/**
 * 构建写入渠道配置的 updates（config.updateConfig 的 updates 字段）。
 *
 * 写入字段与设置页完全一致：
 * - off：只关闭闸门（options 原样保留，避免副作用）；
 * - low/medium/high：开启闸门并写 effort / thinkingLevel，
 *   其余字段（summary/budget_tokens/display 等）保留当前值。
 */
export function buildThinkingLevelUpdates(config: any, level: ThinkingLevel): Record<string, any> | null {
  if (!supportsThinkingLevel(config)) return null
  const type: string = config.type
  const options = config.options || {}
  const optionsEnabled = config.optionsEnabled || {}

  if (OPENAI_THINKING_TYPES.has(type)) {
    const updates: Record<string, any> = {
      optionsEnabled: { ...optionsEnabled, reasoning: level !== 'off' }
    }
    if (level !== 'off') {
      const current = options.reasoning || {}
      updates.options = {
        ...options,
        reasoning: {
          effort: level,
          summaryEnabled: current.summaryEnabled ?? false,
          summary: current.summary ?? 'auto'
        }
      }
    }
    return updates
  }

  if (ANTHROPIC_THINKING_TYPES.has(type)) {
    const updates: Record<string, any> = {
      optionsEnabled: { ...optionsEnabled, thinking: level !== 'off' }
    }
    if (level !== 'off') {
      const current = options.thinking || {}
      // Anthropic 的 effort 仅在 adaptive 模式经 output_config 生效（enabled 模式只看
      // budget_tokens）——快捷档位要真正控制思考强度，必须落成 adaptive + effort；
      // 其余字段（budget_tokens/display 等）保留当前值，设置页可见。
      updates.options = {
        ...options,
        thinking: {
          ...current,
          type: 'adaptive',
          effort: level
        }
      }
    }
    return updates
  }

  if (GEMINI_THINKING_TYPES.has(type)) {
    const updates: Record<string, any> = {
      optionsEnabled: { ...optionsEnabled, thinkingConfig: level !== 'off' }
    }
    if (level !== 'off') {
      const current = options.thinkingConfig || {}
      updates.options = {
        ...options,
        thinkingConfig: {
          ...current,
          includeThoughts: true,
          mode: 'level',
          thinkingLevel: level
        }
      }
    }
    return updates
  }

  return null
}
