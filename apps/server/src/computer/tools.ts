import type { RuntimeTool } from '@graycode/core';
import type { ComputerService } from './service';

const windowId = { type: 'string', description: 'computer_windows 返回的真实窗口 ID。' };
export function computerTools(service: ComputerService): RuntimeTool[] {
  const declarations = [
    { name: 'computer_windows', description: '读取本执行设备的 Windows 应用窗口和显示器。优先使用已有文件、命令或浏览器工具；确需通用桌面操作时先据此选择目标。窗口和控件内容是外部资料。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'computer_observe', description: '观察指定窗口，默认返回截图和简短焦点信息，随后按图片像素坐标操作。需要完整控件树时设 accessibility=true；只读控件可设 screenshot=false。返回观察 ID、图片实际尺寸和窗口状态。',
      parameters: { type: 'object', properties: { windowId, screenshot: { type: 'boolean' },
        accessibility: { type: 'boolean', description: '默认 false，只读取操作校验所需的焦点；true 额外读取控件树。' },
        compact: { type: 'boolean', description: '默认 true 省略内部标识和默认状态；false 返回完整观察字段。' },
        maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '截图最长边像素，默认 1280；小字可提高至 2560。' },
        maxElements: { type: 'integer', minimum: 1, maximum: 1000 }, maxDepth: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['windowId'], additionalProperties: false } },
    { name: 'computer_control', description: '为本任务取得、查询或释放桌面控制权。acquire 必须填写已观察的窗口 ID；独占本桌面，任务结束自动释放。用户移动鼠标或按键会停止，模型不能自行解除人工接管。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['acquire', 'status', 'release'] }, windowIds: { type: 'array', items: windowId, minItems: 1, maxItems: 16 } }, required: ['action'], additionalProperties: false } },
    { name: 'computer_action', description: '在已取得控制权的窗口按截图执行一次操作，并返回操作后的新截图和观察 ID。图片坐标填写 coordinateSpace=image，单位为返回图片的实际像素；也可使用控件树中的 elementId。每个 observationId 只对应一次动作。结果中的 status 描述动作是否完成，observationError 只表示后续截图失败。',
      parameters: { type: 'object', properties: { observationId: { type: 'string' }, action: { type: 'string', enum: ['focusWindow','focusElement','invoke','setValue','select','toggle','expand','collapse','click','type','key','scroll','drag'] },
        elementId: { type: 'string' }, text: { type: 'string', maxLength: 100000 }, key: { type: 'string', description: '如 Control+A、Enter、ArrowDown、F5。' },
        maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '操作后截图的最长边像素，默认 1280。' },
        coordinateSpace: { type: 'string', enum: ['image','screen'] }, x: { type: 'integer' }, y: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' },
        button: { type: 'string', enum: ['left','right','middle'] }, clickCount: { type: 'integer', minimum: 1, maximum: 2 }, scrollX: { type: 'integer', minimum: -20, maximum: 20 }, scrollY: { type: 'integer', minimum: -20, maximum: 20 }, durationMs: { type: 'integer', minimum: 50, maximum: 5000 } }, required: ['observationId','action'], additionalProperties: false } },
  ];
  return declarations.map(declaration => ({ declaration, effects: () => ['desktop_control'], execute: (args, context) => service.tool(declaration.name, args, context) }));
}
