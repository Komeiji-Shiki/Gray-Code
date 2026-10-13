interface ChannelOptionsConfig {
  options?: Record<string, any>
  optionsEnabled?: Record<string, boolean>
}

interface ChannelOptionsUpdates {
  option: (key: string, value: any) => void
  enabled: (key: string, enabled: boolean, value?: any) => void
}

/** 共用参数合并与开关通知；各渠道仍自行声明默认值及数字草稿策略。 */
export function useChannelOptions(
  getConfig: () => ChannelOptionsConfig | undefined,
  defaults: Record<string, any>,
  updates: ChannelOptionsUpdates
) {
  function isOptionEnabled(key: string): boolean {
    return getConfig()?.optionsEnabled?.[key] ?? false
  }

  function handleOptionEnabledChange(key: string, enabled: boolean) {
    if (!enabled || !(key in defaults)) {
      updates.enabled(key, enabled)
      return
    }
    const current = getConfig()?.options?.[key]
    const fallback = defaults[key]
    const value = typeof fallback === 'object' && fallback !== null
      ? { ...fallback, ...(current || {}) }
      : current ?? fallback
    // 一次通知携带启用状态和补全后的值，沿用父组件的原子更新入口。
    updates.enabled(key, enabled, value)
  }

  function getNestedOptionValue(key: string, field: string, fallback: any = undefined): any {
    return getConfig()?.options?.[key]?.[field] ?? fallback
  }

  function updateNestedOption(key: string, field: string, value: any) {
    updates.option(key, {
      ...defaults[key],
      ...(getConfig()?.options?.[key] || {}),
      [field]: value
    })
  }

  // 仅供清空即恢复渠道默认的输入使用；Gemini 的回填草稿仍留在组件内。
  function handleNumberChange(key: string, event: Event) {
    const value = (event.target as HTMLInputElement).value
    updates.option(key, value === '' ? undefined : Number(value))
  }

  return { isOptionEnabled, handleOptionEnabledChange, getNestedOptionValue, updateNestedOption, handleNumberChange }
}
