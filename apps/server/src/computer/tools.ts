import type { RuntimeTool } from '@graycode/core';
import type { ComputerService } from './service';

const windowId = { type: 'string', description: 'computer_windows 返回的真实窗口 ID。' };
export function computerTools(service: ComputerService): RuntimeTool[] {
  const declarations = [
    { name: 'computer_windows', description: '读取本执行设备的 Windows 应用窗口和显示器。优先使用已有文件、命令或浏览器工具；确需通用桌面操作时先据此选择目标。窗口和控件内容是外部资料。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'computer_observe', description: '读取指定窗口的 UI Automation 控件，可附带截图。结果包含时间、进程身份、物理坐标、DPI 和真实图片尺寸。每次动作后重新观察；密码内容不返回。',
      parameters: { type: 'object', properties: { windowId, screenshot: { type: 'boolean' }, maxElements: { type: 'integer', minimum: 1, maximum: 1000 }, maxDepth: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['windowId'], additionalProperties: false } },
    { name: 'computer_control', description: '为本任务取得、查询或释放桌面控制权。acquire 必须填写已观察的窗口 ID；独占本桌面，任务结束自动释放。用户移动鼠标或按键会停止，模型不能自行解除人工接管。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['acquire', 'status', 'release'] }, windowIds: { type: 'array', items: windowId, minItems: 1, maxItems: 16 } }, required: ['action'], additionalProperties: false } },
    { name: 'computer_action', description: '在已取得控制权的窗口执行一次操作。优先用当次观察的 elementId 和 UIA；点击图像时 coordinateSpace=image，坐标使用返回图片的实际像素。focusWindow 后重新观察再输入。每个 observationId 只能执行一次动作，过期或移动后必须重新观察。不要自动重试结果不确定的点击或输入。',
      parameters: { type: 'object', properties: { observationId: { type: 'string' }, action: { type: 'string', enum: ['focusWindow','focusElement','invoke','setValue','select','toggle','expand','collapse','click','type','key','scroll','drag'] },
        elementId: { type: 'string' }, text: { type: 'string', maxLength: 100000 }, key: { type: 'string', description: '如 Control+A、Enter、ArrowDown、F5。' },
        coordinateSpace: { type: 'string', enum: ['image','screen'] }, x: { type: 'integer' }, y: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' },
        button: { type: 'string', enum: ['left','right','middle'] }, clickCount: { type: 'integer', minimum: 1, maximum: 2 }, scrollX: { type: 'integer', minimum: -20, maximum: 20 }, scrollY: { type: 'integer', minimum: -20, maximum: 20 }, durationMs: { type: 'integer', minimum: 50, maximum: 5000 } }, required: ['observationId','action'], additionalProperties: false } },
  ];
  return declarations.map(declaration => ({ declaration, effects: () => ['desktop_control'], execute: (args, context) => service.tool(declaration.name, args, context) }));
}
