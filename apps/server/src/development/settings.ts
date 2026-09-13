import type { DevelopmentSettings } from '@graycode/contracts';

export function validateDevelopmentSettings(value: DevelopmentSettings | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('开发服务设置必须是对象。');
  const identity = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
  if (value.disabledLanguageServers !== undefined && (!Array.isArray(value.disabledLanguageServers) || !value.disabledLanguageServers.every(identity)))
    throw new Error('停用的语言服务标识无效。');
  for (const group of [value.languageServers, value.debugAdapters]) {
    if (group === undefined) continue;
    if (!Array.isArray(group)) throw new Error('开发服务列表必须是数组。');
    const ids = new Set<string>();
    for (const item of group) {
      if (!item || !identity(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() ||
        typeof item.command !== 'string' || item.command.includes('\0') || !item.command.trim() && !('transport' in item && item.transport === 'tcp') ||
        !Array.isArray(item.args) || !item.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))
        throw new Error('开发服务需要唯一标识、名称、启动程序和参数数组。');
      ids.add(item.id);
    }
  }
  for (const server of value.languageServers ?? []) {
    if (!Array.isArray(server.languages) || !server.languages.length || !server.languages.every(identity)) throw new Error('语言服务需要指定语言标识。');
    for (const options of [server.initializationOptions, server.settings])
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new Error('语言服务选项必须是对象。');
  }
  for (const adapter of value.debugAdapters ?? []) if (!['stdio', 'tcp'].includes(adapter.transport) ||
    adapter.host !== undefined && (typeof adapter.host !== 'string' || !adapter.host.trim() || adapter.host.includes('\0')) ||
    adapter.transport === 'tcp' && !adapter.port || adapter.port !== undefined &&
    (!Number.isSafeInteger(adapter.port) || adapter.port < 1 || adapter.port > 65535)) throw new Error('调试器的传输方式或端口无效。');
}
