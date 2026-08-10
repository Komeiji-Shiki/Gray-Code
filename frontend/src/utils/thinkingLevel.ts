/**
 * 思考强度快捷切换工具
 *
 * 聊天输入区「思考强度」下拉框与设置页展示**同一套**渠道配置字段
 * （config.updateConfig），选项覆盖设置页全部档位（不做裁剪、不做合并），
 * 下拉选择直接反映到设置页（反之亦然）。
 *
 * 档位口径（选项文案刻意保持英文不翻译，即各 API 的原始取值）：
 * - openai / openai-responses：Off / none / minimal / low / medium / high / xhigh / max / ultra / custom
 *   → options.reasoning.effort（闸门 optionsEnabled.reasoning）
 * - anthropic：Off / low / medium / high / xhigh / max / ultra / custom
 *   → options.thinking.type + effort（闸门 optionsEnabled.thinking）
 * - gemini：Off / minimal / low / medium / high
 *   → options.thinkingConfig.mode + thinkingLevel（闸门 optionsEnabled.thinkingConfig）
 *
 * Off 语义（关闭思考）：
 * - anthropic：显式写 thinking.type = 'disabled'（闸门保持开启，后端请求显式携带
 *   {"thinking": {"type": "disabled"}}）；
 * - gemini：显式写 thinkingConfig.includeThoughts = false（闸门保持开启，后端请求
 *   显式携带 {"thinkingConfig": {"includeThoughts": false}}——Gemini 缺省即思考，
 *   必须显式传递 false 才真正关闭）；
 * - openai 系：关闭闸门并同步记录 effort = 'none'（重新开启时回到 none 而非默认
 *   high），后端 formatter 对「闸门关闭 + effort='none'」**强制透传**
 *   {"reasoning": {"effort": "none"}}——OpenAI 请求缺省 reasoning 段时模型仍按
 *   默认强度思考，只有显式 effort='none' 才真正关闭思考。
 *
 * none 语义（仅 openai 系）：思考保持开启（闸门 true），但 effort = 'none'
 * ——后端 formatter 对 'none' 不发送 reasoning.effort 参数（请求缺省该段，
 * 完全不传递思考参数，模型按 API 默认行为思考），与 Off（强制传递禁用参数）严格区分。
 */

export interface ThinkingLevelOption {
  value: string
  label: string
}

/** Off 档位值（各渠道通用） */
export const THINKING_OFF = 'off'

const OPENAI_THINKING_OPTIONS: ThinkingLevelOption[] = [
  { value: THINKING_OFF, label: 'Off' },
  { value: 'none', label: 'none' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultra', label: 'ultra' },
  { value: 'custom', label: 'custom' }
]

const ANTHROPIC_THINKING_OPTIONS: ThinkingLevelOption[] = [
  { value: THINKING_OFF, label: 'Off' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultra', label: 'ultra' },
  { value: 'custom', label: 'custom' }
]

const GEMINI_THINKING_OPTIONS: ThinkingLevelOption[] = [
  { value: THINKING_OFF, label: 'Off' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' }
]

const OPENAI_THINKING_TYPES = new Set(['openai', 'openai-responses'])
const ANTHROPIC_THINKING_TYPES = new Set(['anthropic'])
const GEMINI_THINKING_TYPES = new Set(['gemini'])

/** 渠道类型是否支持思考强度快捷控制 */
export function supportsThinkingLevel(config: any): boolean {
  if (!config || typeof config !== 'object') return false
  const type = typeof config.type === 'string' ? config.type : ''
  return OPENAI_THINKING_TYPES.has(type) || ANTHROPIC_THINKING_TYPES.has(type) || GEMINI_THINKING_TYPES.has(type)
}

/** 渠道类型对应的完整档位列表（与设置页一致，不裁剪） */
export function getThinkingLevelOptions(config: any): ThinkingLevelOption[] {
  if (!supportsThinkingLevel(config)) return []
  const type: string = config.type
  if (OPENAI_THINKING_TYPES.has(type)) return OPENAI_THINKING_OPTIONS
  if (ANTHROPIC_THINKING_TYPES.has(type)) return ANTHROPIC_THINKING_OPTIONS
  if (GEMINI_THINKING_TYPES.has(type)) return GEMINI_THINKING_OPTIONS
  return []
}

/**
 * 读取当前渠道配置对应的思考强度档位（精确值，不做档位归并）。
 *
 * 闸门语义与设置页一致：openai/anthropic 闸门默认关闭（显示 Off），
 * gemini 默认开启（thinkingConfig 默认思考）。
 * gemini default / budget 模式没有档位概念，按中档（medium）展示。
 */
export function getThinkingLevel(config: any): string {
  if (!supportsThinkingLevel(config)) return THINKING_OFF
  const type: string = config.type
  const options = config.options || {}
  const optionsEnabled = config.optionsEnabled || {}

  if (OPENAI_THINKING_TYPES.has(type)) {
    if (!optionsEnabled.reasoning) return THINKING_OFF
    return options.reasoning?.effort || 'high'
  }

  if (ANTHROPIC_THINKING_TYPES.has(type)) {
    if (!optionsEnabled.thinking) return THINKING_OFF
    const thinking = options.thinking || {}
    if (thinking.type === 'disabled') return THINKING_OFF
    return thinking.effort || 'high'
  }

  if (GEMINI_THINKING_TYPES.has(type)) {
    if (optionsEnabled.thinkingConfig === false) return THINKING_OFF
    const thinkingConfig = options.thinkingConfig || {}
    if (thinkingConfig.includeThoughts === false) return THINKING_OFF
    if (thinkingConfig.mode === 'level') return thinkingConfig.thinkingLevel || 'medium'
    // default / budget 模式：使用 API 默认思考强度（按中档展示）
    return 'medium'
  }

  return THINKING_OFF
}

/**
 * 构建写入渠道配置的 updates（config.updateConfig 的 updates 字段）。
 *
 * - Off：openai 系 / gemini 只关闸门；anthropic 显式写 thinking.type='disabled'
 *   （闸门保持开启，后端请求显式携带 {"thinking":{"type":"disabled"}}）；
 * - 档位（none/minimal/low/medium/high/xhigh/max/ultra/custom）：开启闸门并写
 *   effort / thinkingLevel 精确值，其余字段（summary/effortCustom/budget_tokens/
 *   display 等）保留当前值；anthropic 档位写入强制 type='adaptive'（effort 仅该
 *   模式经 output_config 生效）。
 */
export function buildThinkingLevelUpdates(config: any, level: string): Record<string, any> | null {
  if (!supportsThinkingLevel(config)) return null
  const type: string = config.type
  const options = config.options || {}
  const optionsEnabled = config.optionsEnabled || {}

  if (OPENAI_THINKING_TYPES.has(type)) {
    const current = options.reasoning || {}
    const reasoningDefaults = { effort: 'high', summaryEnabled: false, summary: 'auto' }
    if (level === THINKING_OFF) {
      // OpenAI 无独立 disabled 参数（请求缺省 reasoning 段即关闭思考）：
      // 关闭闸门并记录 effort='none'，保证 Off 是「显式配置的关闭」而非只拨开关
      return {
        optionsEnabled: { ...optionsEnabled, reasoning: false },
        options: {
          ...options,
          reasoning: {
            ...reasoningDefaults,
            ...current,
            effort: 'none'
          }
        }
      }
    }
    return {
      optionsEnabled: { ...optionsEnabled, reasoning: true },
      options: {
        ...options,
        reasoning: {
          ...reasoningDefaults,
          ...current,
          effort: level
        }
      }
    }
  }

  if (ANTHROPIC_THINKING_TYPES.has(type)) {
    const current = options.thinking || {}
    if (level === THINKING_OFF) {
      // 显式关闭思考：闸门保持开启，请求携带 thinking.type='disabled'
      return {
        optionsEnabled: { ...optionsEnabled, thinking: true },
        options: {
          ...options,
          thinking: {
            ...current,
            type: 'disabled'
          }
        }
      }
    }
    return {
      optionsEnabled: { ...optionsEnabled, thinking: true },
      options: {
        ...options,
        thinking: {
          ...current,
          type: 'adaptive',
          effort: level
        }
      }
    }
  }

  if (GEMINI_THINKING_TYPES.has(type)) {
    const current = options.thinkingConfig || {}
    if (level === THINKING_OFF) {
      // 显式关闭思考：闸门保持开启，请求携带 {"thinkingConfig": {"includeThoughts": false}}
      return {
        optionsEnabled: { ...optionsEnabled, thinkingConfig: true },
        options: {
          ...options,
          thinkingConfig: {
            ...current,
            includeThoughts: false
          }
        }
      }
    }
    return {
      optionsEnabled: { ...optionsEnabled, thinkingConfig: true },
      options: {
        ...options,
        thinkingConfig: {
          ...current,
          includeThoughts: true,
          mode: 'level',
          thinkingLevel: level
        }
      }
    }
  }

  return null
}
