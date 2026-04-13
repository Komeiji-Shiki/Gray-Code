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
      return ''
    }

    if (name === 'appName') return context.appName
    if (name === 'windowTitle') return context.windowTitle
    if (name === 'actionLabel') return context.actionLabel ?? ''
    return context.reasonLabel
  }).trim()
}
