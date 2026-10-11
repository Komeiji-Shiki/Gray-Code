export const snapshotProperties = {
  compact: { type: 'boolean', description: '默认 true 返回简洁文本节点；false 返回完整节点字段。' },
  maxNodes: { type: 'integer', minimum: 1, maximum: 1000 },
  query: { type: 'string', minLength: 1, maxLength: 1000, description: '不区分大小写的文字片段，匹配名称、段落正文、值、描述或链接 URL。' },
  role: { type: 'string', description: '按 snapshot 中的角色筛选，如 link、button、textbox、heading、row、combobox。' },
  interactiveOnly: { type: 'boolean', description: '只读取交互目标，包括按钮、链接、输入框，以及带点击监听或 pointer 光标的自定义元素。' },
  frameId: { type: 'string', description: '快照 frame= 行给出的框架 ID，限定读取某个 iframe。' },
};
export const actionObservationProperties = {
  after: { type: 'string', enum: ['snapshot', 'screenshot', 'both', 'none'], default: 'snapshot', description: '默认 snapshot 返回页面状态和带 ref 的新快照；screenshot 返回截图，适合画布或看布局；both 返回两者；none 只返回页面状态，适合连续填写，最后一步再观察。' },
  snapshotOptions: { type: 'object', properties: snapshotProperties, additionalProperties: false, description: '动作后快照的筛选。快照从头读取，不沿用动作前的 ref 或 offset。' },
  maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '动作后截图最长边像素，默认 1280。' },
};
export interface ActionObservationOptions {
  after: 'screenshot' | 'snapshot' | 'both' | 'none';
  maxImageDimension?: number;
  snapshotOptions?: { compact?: boolean; maxNodes?: number; query?: string; role?: string; interactiveOnly?: boolean; frameId?: string };
}
/** 参数类型已由工具 schema 校验；这里只补默认值和 schema 表达不了的组合规则。 */
export function actionObservationOptions(args: Record<string, unknown>, fallback: ActionObservationOptions['after'] = 'snapshot'): ActionObservationOptions {
  const options = { after: (args.after ?? fallback) as ActionObservationOptions['after'],
    snapshotOptions: args.snapshotOptions as ActionObservationOptions['snapshotOptions'], maxImageDimension: args.maxImageDimension as number | undefined };
  if (options.snapshotOptions && options.after !== 'snapshot' && options.after !== 'both')
    throw Object.assign(new Error('snapshotOptions 只用于 after=snapshot 或 both。'), { code: 'INVALID_ARGUMENTS' });
  return options;
}
