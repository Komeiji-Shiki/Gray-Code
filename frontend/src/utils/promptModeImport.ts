type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

/** 兼容单预设、数组、旧模式映射，以及完整设置导出中的提示词部分。 */
export function promptModeImportSources(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = object(payload)
  const prompt = [root.vscodeSettings, root.features, root.globalSettings, root].map(value => {
    const settings = object(value)
    return object(settings.toolsConfig ?? settings['graycode.toolsConfig']).system_prompt
  }).find(value => value !== undefined)
  const bundle = object(prompt ?? payload)
  if (Array.isArray(bundle.modes)) return bundle.modes
  if (bundle.modes && typeof bundle.modes === 'object') return Object.values(bundle.modes)
  if (bundle.mode !== undefined) return [bundle.mode]
  return [prompt ?? payload]
}

/** 不把未识别的 JSON 静默填充成默认模板。 */
export function isPromptModeImportSource(value: unknown): boolean {
  const mode = object(value)
  return typeof mode.template === 'string' || Array.isArray(mode.promptEntries)
}
