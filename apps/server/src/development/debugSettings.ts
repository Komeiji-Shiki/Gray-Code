import type { DebugBreakpoint, DebugConfiguration } from '@graycode/contracts';

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');
export function validateDebugConfiguration(value: DebugConfiguration) {
  if (!plainObject(value) || !text(value.id) || !value.id || !text(value.name) || !value.name.trim() ||
    !text(value.adapterId) || !value.adapterId || !['launch', 'attach'].includes(value.request)) throw new Error('调试配置需要名称、调试器和启动方式。');
  for (const field of ['program', 'cwd', 'runtimeExecutable', 'host'] as const)
    if (value[field] !== undefined && !text(value[field])) throw new Error('调试配置中的路径或主机名无效。');
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(text))) throw new Error('运行参数必须逐项填写。');
  if (value.console !== undefined && !['internalConsole', 'integratedTerminal'].includes(value.console)) throw new Error('请选择有效的程序输入输出方式。');
  if (value.env !== undefined && (!plainObject(value.env) || !Object.entries(value.env).every(([key, item]) => text(key) && key.length && !key.includes('=') && (item === null || text(item)))))
    throw new Error('环境变量名称或值无效。');
  if (value.port !== undefined && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535)) throw new Error('调试端口必须在 1 至 65535 之间。');
  if (value.options !== undefined && (!plainObject(value.options) || Object.keys(value.options).some(key => key.startsWith('__')))) throw new Error('高级调试选项必须是对象，不能包含内部会话标识。');
}
export function validateDebugBreakpoints(values: DebugBreakpoint[]) {
  if (!Array.isArray(values)) throw new Error('断点列表无效。');
  const ids = new Set<string>();
  for (const value of values) {
    if (!plainObject(value) || !text(value.id) || !value.id || ids.has(value.id) || !text(value.path) || !value.path ||
      !Number.isSafeInteger(value.line) || value.line < 1 || typeof value.enabled !== 'boolean' ||
      value.column !== undefined && (!Number.isSafeInteger(value.column) || value.column < 1)) throw new Error('断点需要有效的文件与行号。');
    for (const key of ['condition', 'hitCondition', 'logMessage'] as const)
      if (value[key] !== undefined && !text(value[key])) throw new Error('断点条件或日志内容无效。');
    ids.add(value.id);
  }
}
