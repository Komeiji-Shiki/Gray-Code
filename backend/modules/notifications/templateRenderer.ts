export interface WindowsAgentStopNotificationTemplateContext {
  appName: string
  windowTitle: string
  actionLabel?: string
  reasonLabel: string
}

const ALLOWED_TEMPLATE_VARIABLES = new Set([
  'appName',
  'windowTitle',
  'actionLabel',
  'reasonLabel'
] as const)

export function renderWindowsAgentStopTemplate(
  template: string,
  context: WindowsAgentStopNotificationTemplateContext
): string {
  if (!template) {
    return ''
  }

  return template.replace(/\{([^{}]+)\}/g, (_match, rawName: string) => {
    const name = String(rawName || '').trim()
    if (!ALLOWED_TEMPLATE_VARIABLES.has(name as 'appName' | 'windowTitle' | 'actionLabel' | 'reasonLabel')) {
      // 未知变量保留原样（而非静默替换为空串）：模板拼写错误在通知里可见，便于排查
      return `{${rawName}}`
    }

    if (name === 'appName') return context.appName
    if (name === 'windowTitle') return context.windowTitle
    if (name === 'actionLabel') return context.actionLabel ?? ''
    return context.reasonLabel
  }).trim()
}
