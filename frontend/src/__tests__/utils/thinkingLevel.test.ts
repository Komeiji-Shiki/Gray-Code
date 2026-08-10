/**
 * thinkingLevel.test.ts - 思考强度档位映射回归测试
 *
 * 覆盖：四类渠道的读取映射（含默认值/闸门语义）、写入 updates 构建、
 * 不支持类型返回 null、档位文案保持英文不翻译。
 */

import {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  supportsThinkingLevel,
  getThinkingLevel,
  buildThinkingLevelUpdates
} from '../../utils/thinkingLevel'

describe('supportsThinkingLevel', () => {
  it('支持 openai / openai-responses / anthropic / gemini 四类渠道', () => {
    for (const type of ['openai', 'openai-responses', 'anthropic', 'gemini']) {
      expect(supportsThinkingLevel({ type })).toBe(true)
    }
  })

  it('其它类型或空配置不支持', () => {
    expect(supportsThinkingLevel({ type: 'other' })).toBe(false)
    expect(supportsThinkingLevel(null)).toBe(false)
    expect(supportsThinkingLevel(undefined)).toBe(false)
    expect(supportsThinkingLevel({})).toBe(false)
  })
})

describe('getThinkingLevel - openai / openai-responses', () => {
  const base = { type: 'openai' }

  it('闸门关闭（未开启）→ off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: false } })).toBe('off')
    expect(getThinkingLevel({ ...base })).toBe('off')
  })

  it('effort 各档位正确映射', () => {
    const enabled = { optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'none' } } }
    expect(getThinkingLevel({ ...base, ...enabled })).toBe('off')
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'minimal' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'low' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'medium' } } })).toBe('medium')
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'high' } } })).toBe('high')
  })

  it('xhigh / max / ultra / custom 归入 high', () => {
    for (const effort of ['xhigh', 'max', 'ultra', 'custom']) {
      expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: { reasoning: { effort } } })).toBe('high')
    }
  })

  it('开启但未配置 effort → 默认 high', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: {} })).toBe('high')
  })
})

describe('getThinkingLevel - anthropic', () => {
  const base = { type: 'anthropic' }

  it('闸门关闭或 type=disabled → off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinking: false } })).toBe('off')
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinking: true }, options: { thinking: { type: 'disabled' } } })).toBe('off')
  })

  it('effort 各档位正确映射', () => {
    const enabled = { optionsEnabled: { thinking: true } }
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'low' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'medium' } } })).toBe('medium')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'enabled', effort: 'high' } } })).toBe('high')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'ultra' } } })).toBe('high')
  })
})

describe('getThinkingLevel - gemini', () => {
  const base = { type: 'gemini' }

  it('闸门关闭或 includeThoughts=false → off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinkingConfig: false } })).toBe('off')
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { includeThoughts: false } } })).toBe('off')
  })

  it('闸门未定义默认开启（gemini 默认思考）', () => {
    expect(getThinkingLevel({ ...base, options: {} })).toBe('medium')
  })

  it('level 模式按 thinkingLevel 映射', () => {
    const config = { ...base, options: { thinkingConfig: { mode: 'level', thinkingLevel: 'high' } } }
    expect(getThinkingLevel(config)).toBe('high')
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { mode: 'level', thinkingLevel: 'minimal' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { mode: 'level', thinkingLevel: 'low' } } })).toBe('low')
  })

  it('default / budget 模式 → medium', () => {
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { mode: 'budget', thinkingBudget: 2048 } } })).toBe('medium')
  })
})

describe('buildThinkingLevelUpdates', () => {
  it('不支持的类型返回 null', () => {
    expect(buildThinkingLevelUpdates({ type: 'other' }, 'high')).toBeNull()
  })

  it('openai: off 只关闸门，其余写 effort 且保留 summary 字段', () => {
    const config = {
      type: 'openai',
      optionsEnabled: { reasoning: true, temperature: true },
      options: { reasoning: { effort: 'high', summaryEnabled: true, summary: 'concise' }, temperature: 1.0 }
    }
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { reasoning: false, temperature: true }
    })
    expect(buildThinkingLevelUpdates(config, 'low')).toEqual({
      optionsEnabled: { reasoning: true, temperature: true },
      options: { reasoning: { effort: 'low', summaryEnabled: true, summary: 'concise' }, temperature: 1.0 }
    })
  })

  it('anthropic: 写档位强制 type=adaptive（effort 仅该模式生效），保留其它字段', () => {
    const config = {
      type: 'anthropic',
      optionsEnabled: { thinking: true },
      options: { thinking: { type: 'enabled', budget_tokens: 5000, effort: 'high', display: 'omitted' } }
    }
    expect(buildThinkingLevelUpdates(config, 'medium')).toEqual({
      optionsEnabled: { thinking: true },
      options: { thinking: { type: 'adaptive', budget_tokens: 5000, effort: 'medium', display: 'omitted' } }
    })
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { thinking: false }
    })
  })

  it('gemini: 写 mode=level + thinkingLevel，保留 thinkingBudget', () => {
    const config = {
      type: 'gemini',
      optionsEnabled: { thinkingConfig: true },
      options: { thinkingConfig: { includeThoughts: true, mode: 'budget', thinkingLevel: 'low', thinkingBudget: 2048 } }
    }
    expect(buildThinkingLevelUpdates(config, 'high')).toEqual({
      optionsEnabled: { thinkingConfig: true },
      options: { thinkingConfig: { includeThoughts: true, mode: 'level', thinkingLevel: 'high', thinkingBudget: 2048 } }
    })
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { thinkingConfig: false }
    })
  })
})

describe('档位文案保持英文（不翻译）', () => {
  it('四级档位标签为英文原文', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high'])
    expect(THINKING_LEVEL_LABELS.off).toBe('Off')
    expect(THINKING_LEVEL_LABELS.low).toBe('Low')
    expect(THINKING_LEVEL_LABELS.medium).toBe('Medium')
    expect(THINKING_LEVEL_LABELS.high).toBe('High')
  })
})
