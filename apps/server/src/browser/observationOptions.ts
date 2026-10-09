import Ajv from 'ajv';

export const snapshotProperties = {
  compact: { type: 'boolean', description: '默认 true 返回简洁文本节点；false 返回完整节点字段。' },
  maxNodes: { type: 'integer', minimum: 1, maximum: 1000 },
  query: { type: 'string', minLength: 1, maxLength: 1000, description: '不区分大小写的文字片段，匹配名称、段落正文、值、描述或链接 URL。' },
  role: { type: 'string', description: '按 snapshot 中的角色筛选，如 link、button、textbox、heading、row、combobox。' },
  interactiveOnly: { type: 'boolean', description: '只读取交互目标，包括按钮、链接、输入框，以及带点击监听或 pointer 光标的自定义元素。' },
  frameId: { type: 'string', description: '从 frames 返回值取得，限定读取某个 iframe。' },
};
export const actionObservationProperties = {
  after: { type: 'string', enum: ['screenshot', 'snapshot', 'both'], default: 'screenshot', description: '动作后的观察方式：默认 screenshot 返回截图，snapshot 返回带新 ref 的快照，both 同时返回两者。' },
  snapshotOptions: { type: 'object', properties: snapshotProperties, additionalProperties: false, description: '仅在 after=snapshot 或 both 时使用的快照筛选。快照从头读取，不沿用动作前的 ref 或 offset。' },
  maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '操作后截图最长边像素，默认 1280。' },
};
export interface ActionObservationOptions {
  after?: 'screenshot' | 'snapshot' | 'both';
  maxImageDimension?: number;
  snapshotOptions?: { compact?: boolean; maxNodes?: number; query?: string; role?: string; interactiveOnly?: boolean; frameId?: string };
}
const validate = new Ajv({ strict: false }).compile({ type: 'object', properties: actionObservationProperties, additionalProperties: false });
/** 宿主的直接调用也在派发动作前检查观察参数，避免参数错误被误当成动作后的采集故障。 */
export function actionObservationOptions(args: Record<string, unknown>): ActionObservationOptions {
  const options = { after: args.after, snapshotOptions: args.snapshotOptions, maxImageDimension: args.maxImageDimension };
  if (!validate(options)) throw new Error('动作后观察参数无效，请检查 after、snapshotOptions 和 maxImageDimension。');
  if (options.snapshotOptions !== undefined && (options.after ?? 'screenshot') === 'screenshot') throw new Error('snapshotOptions 需要 after=snapshot 或 both。');
  return options as ActionObservationOptions;
}
