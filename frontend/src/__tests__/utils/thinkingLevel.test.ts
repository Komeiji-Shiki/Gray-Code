/**
 * thinkingLevel.test.ts - 思考强度档位映射回归测试
 *
 * 覆盖：四类渠道的选项列表（与设置页完整对齐，不裁剪）、读取映射（精确值）、
 * Off 语义（openai/gemini 关闸门；anthropic 显式 type=disabled）、
 * none 语义（openai 系：闸门开启但 effort='none'，与 Off 严格区分）、
 * 写入 updates 构建（保留其余字段）、不支持类型返回空/null、
 * 档位文案保持英文不翻译。
 */

import {
  THINKING_OFF,
  getThinkingLevelOptions,
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

describe('getThinkingLevelOptions（与设置页完整对齐，不裁剪）', () => {
  it('openai 系：Off + none/minimal/low/medium/high/xhigh/max/ultra/custom 全档位', () => {
    for (const type of ['openai', 'openai-responses']) {
      const options = getThinkingLevelOptions({ type })
      expect(options.map(o => o.value)).toEqual([
        'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom'
      ])
    }
  })

  it('anthropic：Off + low/medium/high/xhigh/max/ultra/custom', () => {
    const options = getThinkingLevelOptions({ type: 'anthropic' })
    expect(options.map(o => o.value)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom'
    ])
  })

  it('gemini：Off + minimal/low/medium/high', () => {
    const options = getThinkingLevelOptions({ type: 'gemini' })
    expect(options.map(o => o.value)).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })

  it('不支持类型返回空列表', () => {
    expect(getThinkingLevelOptions({ type: 'other' })).toEqual([])
  })

  it('档位文案为英文原文（不做翻译），Off 为唯一大写标签', () => {
    for (const type of ['openai', 'anthropic', 'gemini']) {
      const options = getThinkingLevelOptions({ type })
      expect(options[0]).toEqual({ value: 'off', label: 'Off' })
      for (const opt of options.slice(1)) {
        expect(opt.label).toBe(opt.value)
      }
    }
  })
})

describe('getThinkingLevel - openai / openai-responses', () => {
  const base = { type: 'openai' }

  it('闸门关闭（未开启）→ off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: false } })).toBe(THINKING_OFF)
    expect(getThinkingLevel({ ...base })).toBe(THINKING_OFF)
  })

  it('effort 各档位精确读取（none 不等于 off）', () => {
    const enabled = { optionsEnabled: { reasoning: true } }
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'none' } } })).toBe('none')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'minimal' } } })).toBe('minimal')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'low' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'medium' } } })).toBe('medium')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'high' } } })).toBe('high')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'xhigh' } } })).toBe('xhigh')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'max' } } })).toBe('max')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'ultra' } } })).toBe('ultra')
    expect(getThinkingLevel({ ...base, ...enabled, options: { reasoning: { effort: 'custom', effortCustom: '0.9' } } })).toBe('custom')
  })

  it('开启但未配置 effort → 默认 high', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { reasoning: true }, options: {} })).toBe('high')
  })
})

describe('getThinkingLevel - anthropic', () => {
  const base = { type: 'anthropic' }

  it('闸门关闭或 type=disabled → off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinking: false } })).toBe(THINKING_OFF)
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinking: true }, options: { thinking: { type: 'disabled' } } })).toBe(THINKING_OFF)
  })

  it('effort 各档位精确读取', () => {
    const enabled = { optionsEnabled: { thinking: true } }
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'low' } } })).toBe('low')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'medium' } } })).toBe('medium')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'high' } } })).toBe('high')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'xhigh' } } })).toBe('xhigh')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'max' } } })).toBe('max')
    expect(getThinkingLevel({ ...base, ...enabled, options: { thinking: { type: 'adaptive', effort: 'ultra' } } })).toBe('ultra')
  })
})

describe('getThinkingLevel - gemini', () => {
  const base = { type: 'gemini' }

  it('闸门关闭或 includeThoughts=false → off', () => {
    expect(getThinkingLevel({ ...base, optionsEnabled: { thinkingConfig: false } })).toBe(THINKING_OFF)
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { includeThoughts: false } } })).toBe(THINKING_OFF)
  })

  it('闸门未定义默认开启（gemini 默认思考）', () => {
    expect(getThinkingLevel({ ...base, options: {} })).toBe('medium')
  })

  it('level 模式按 thinkingLevel 精确读取', () => {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      expect(getThinkingLevel({ ...base, options: { thinkingConfig: { mode: 'level', thinkingLevel: level } } })).toBe(level)
    }
  })

  it('default / budget 模式 → medium', () => {
    expect(getThinkingLevel({ ...base, options: { thinkingConfig: { mode: 'budget', thinkingBudget: 2048 } } })).toBe('medium')
  })
})

describe('buildThinkingLevelUpdates - openai / openai-responses', () => {
  const config = {
    type: 'openai',
    optionsEnabled: { reasoning: true, temperature: true },
    options: { reasoning: { effort: 'high', summaryEnabled: true, summary: 'concise', effortCustom: '0.7' }, temperature: 1.0 }
  }

  it('off：关闭闸门 + 记录 effort=none（OpenAI 无独立 disabled 参数，缺省 reasoning 段即关闭）', () => {
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { reasoning: false, temperature: true },
      options: { reasoning: { effort: 'none', summaryEnabled: true, summary: 'concise', effortCustom: '0.7' }, temperature: 1.0 }
    })
  })

  it('none：闸门保持开启、effort=none（不传递思考强度参数，≠ off）', () => {
    expect(buildThinkingLevelUpdates(config, 'none')).toEqual({
      optionsEnabled: { reasoning: true, temperature: true },
      options: { reasoning: { effort: 'none', summaryEnabled: true, summary: 'concise', effortCustom: '0.7' }, temperature: 1.0 }
    })
  })

  it('xhigh / max / ultra / custom 精确写入且保留其余字段（custom 保留 effortCustom）', () => {
    for (const level of ['xhigh', 'max', 'ultra']) {
      const updates = buildThinkingLevelUpdates(config, level)!
      expect(updates.options.reasoning.effort).toBe(level)
      expect(updates.options.reasoning.summaryEnabled).toBe(true)
      expect(updates.options.reasoning.summary).toBe('concise')
      expect(updates.options.reasoning.effortCustom).toBe('0.7')
      expect(updates.options.temperature).toBe(1.0)
      expect(updates.optionsEnabled.reasoning).toBe(true)
    }
    expect(buildThinkingLevelUpdates(config, 'custom')!.options.reasoning.effort).toBe('custom')
  })
})

describe('buildThinkingLevelUpdates - anthropic', () => {
  const config = {
    type: 'anthropic',
    optionsEnabled: { thinking: true },
    options: { thinking: { type: 'adaptive', budget_tokens: 5000, effort: 'high', display: 'omitted' } }
  }

  it('off：闸门保持开启 + thinking.type=disabled（请求显式携带禁用参数）', () => {
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { thinking: true },
      options: { thinking: { type: 'disabled', budget_tokens: 5000, effort: 'high', display: 'omitted' } }
    })
  })

  it('档位写入强制 type=adaptive（effort 仅该模式生效），保留其它字段', () => {
    expect(buildThinkingLevelUpdates(config, 'medium')).toEqual({
      optionsEnabled: { thinking: true },
      options: { thinking: { type: 'adaptive', budget_tokens: 5000, effort: 'medium', display: 'omitted' } }
    })
    expect(buildThinkingLevelUpdates(config, 'ultra')!.options.thinking.effort).toBe('ultra')
  })
})

describe('buildThinkingLevelUpdates - gemini', () => {
  const config = {
    type: 'gemini',
    optionsEnabled: { thinkingConfig: true },
    options: { thinkingConfig: { includeThoughts: true, mode: 'budget', thinkingLevel: 'low', thinkingBudget: 2048 } }
  }

  it('off：闸门保持开启 + includeThoughts=false（请求显式携带禁用参数）', () => {
    expect(buildThinkingLevelUpdates(config, 'off')).toEqual({
      optionsEnabled: { thinkingConfig: true },
      options: { thinkingConfig: { includeThoughts: false, mode: 'budget', thinkingLevel: 'low', thinkingBudget: 2048 } }
    })
  })

  it('档位写入 mode=level + thinkingLevel，保留 thinkingBudget', () => {
    expect(buildThinkingLevelUpdates(config, 'high')).toEqual({
      optionsEnabled: { thinkingConfig: true },
      options: { thinkingConfig: { includeThoughts: true, mode: 'level', thinkingLevel: 'high', thinkingBudget: 2048 } }
    })
  })
})

describe('buildThinkingLevelUpdates - 边界', () => {
  it('不支持的类型返回 null', () => {
    expect(buildThinkingLevelUpdates({ type: 'other' }, 'high')).toBeNull()
  })
})
