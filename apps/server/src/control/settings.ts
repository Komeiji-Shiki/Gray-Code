import type { ControlApiSettings } from '@graycode/contracts';

export function validateControlApiSettings(settings?: ControlApiSettings): void {
  if (!settings) return;
  if (typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535)
    throw new Error('外部控制接口需要明确的启用状态和 0 至 65535 之间的端口。');
  if (settings.allowLan !== undefined && typeof settings.allowLan !== 'boolean') throw new Error('外部控制接口的局域网开关无效。');
  if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== 'string' || !settings.credentialRef.trim()))
    throw new Error('外部控制接口的令牌引用无效。');
  if (settings.enabled && !settings.credentialRef) throw new Error('启用外部控制接口前，请生成或填写访问令牌。');
}
