import type { RuntimeTool } from '@graycode/core';
import type { ToolEffect } from '@graycode/contracts';
import type { BrowserHost } from './port';

const tabId = { type: 'string', description: '浏览器返回的稳定标签 ID。' };
const ref = { type: 'string', description: '最近一次 snapshot 返回的元素引用；操作或导航后需要重新读取。' };
export function browserTools(host?: BrowserHost): RuntimeTool[] {
  const declarations = [
    { name: 'browser_tabs', description: '管理应用内置浏览器的标签。list 同时返回当前账号的登录配置。create 在后台新建标签；show 在本机主人的工作台显示标签，不显示或聚焦操作系统窗口。任务结束后标签仍可由用户继续使用。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'show', 'close'] }, tabId,
        url: { type: 'string' }, path: { type: 'string', description: '预览本任务工作区中的 HTML 或其他文件，不能和 url 同时使用。' }, profileId: { type: 'string', description: 'list 返回的登录配置 ID；省略时使用本账号的默认配置。' } }, required: ['action'], additionalProperties: false } },
    { name: 'browser_read', description: '优先 screenshot 观察网页，返回图片、观察 ID 和实际图片尺寸，随后按图片像素坐标操作。需要页面文字或元素引用时使用 snapshot，默认最多 250 个节点，可用 ref 聚焦区域。logs 用 nextCursor/since 读取新日志。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['snapshot', 'screenshot', 'logs'] }, tabId, ref,
        compact: { type: 'boolean', description: '默认 true 返回简洁文本节点；false 返回完整节点字段。' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 1000 },
        maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '截图最长边像素，默认 1280；小字可提高至 2560。' },
        since: { type: 'integer', minimum: 0 }, maxEntries: { type: 'integer', minimum: 1, maximum: 200, description: '日志条数，默认最近 50 条。' } }, required: ['action', 'tabId'], additionalProperties: false } },
    { name: 'browser_action', description: '按最近截图的 observationId 和图片像素坐标操作网页，动作后返回新截图。支持点击、双击、右键、拖动、输入、组合键和定点滚动；也保留 ref 元素操作。type 在当前焦点输入，fill 使用 ref 替换文本。status 表示动作结果，observationError 只表示后续截图失败。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['navigate', 'back', 'forward', 'reload', 'click', 'type', 'fill', 'press', 'scroll', 'drag'] }, tabId, ref,
        observationId: { type: 'string', description: '最近截图返回的 id；一次动作后改用新截图的 id。' },
        x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, toX: { type: 'integer', minimum: 0 }, toY: { type: 'integer', minimum: 0 },
        button: { type: 'string', enum: ['left', 'middle', 'right'] }, clickCount: { type: 'integer', minimum: 1, maximum: 2 },
        durationMs: { type: 'integer', minimum: 50, maximum: 2000 },
        maxImageDimension: { type: 'integer', minimum: 320, maximum: 2560, description: '操作后截图最长边像素，默认 1280。' },
        url: { type: 'string', description: 'navigate 的目标地址；其他交互填写最近读取的页面地址，用于确认操作目标。' }, text: { type: 'string', maxLength: 100000 }, key: { type: 'string', description: '如 Enter、Control+A、Shift+Tab、ArrowDown 或 F5。' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, distance: { type: 'integer', minimum: 1, maximum: 10000 } }, required: ['action', 'tabId', 'url'], additionalProperties: false } },
    { name: 'browser_files', description: '在内置浏览器上传或下载文件。上传将获准文件放入页面的文件选择控件；下载直接点击下载元素，将完整响应保存到指定工作区路径，单文件上限 64 MiB。不要先用普通 click 触发下载。文件覆盖需要匹配旧哈希，未保存的编辑会阻止写入。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['upload', 'download'] }, tabId, ref,
        url: { type: 'string', description: '最近读取的页面地址，用于确认文件传输目标。' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        path: { type: 'string', description: '下载文件的工作区目标路径。' }, expectedHash: { type: ['string', 'null'], description: '现有文件的哈希，新文件填写 null。' } }, required: ['action', 'tabId', 'ref', 'url'], additionalProperties: false } },
  ];
  return declarations.map(declaration => ({ declaration,
    effects: (args): ToolEffect[] => declaration.name === 'browser_files' ? ['private_browser', 'external_send', args.action === 'download' ? 'workspace_write' : 'workspace_read']
      : declaration.name === 'browser_action' && ['click', 'type', 'fill', 'press', 'drag'].includes(String(args.action))
      ? ['private_browser', 'external_send'] : declaration.name === 'browser_tabs' && args.action === 'close'
      ? ['private_browser', 'data_delete'] : args.path ? ['private_browser', 'workspace_read'] : ['private_browser'],
    execute: (args, context) => host ? host.tool(declaration.name, args, context) : Promise.resolve({ success: false, code: 'BROWSER_UNAVAILABLE', error: '当前设备没有内置浏览器宿主，请在桌面设备执行此任务。' }),
  }));
}
