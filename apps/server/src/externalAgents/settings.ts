import type { ExternalAgentProfile } from '@graycode/contracts';

export function validateExternalAgentProfiles(profiles: ExternalAgentProfile[] | undefined): void {
  if (profiles === undefined) return;
  if (!Array.isArray(profiles)) throw new Error('外部代理配置必须是列表。');
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id) || ids.has(profile.id)) throw new Error('外部代理标识需要唯一的字母、数字、下划线或连字符。');
    ids.add(profile.id);
    if (typeof profile.name !== 'string' || !profile.name.trim() || typeof profile.command !== 'string' || !profile.command.trim()) throw new Error('请填写外部代理名称和启动命令。');
    if (typeof profile.enabled !== 'boolean' || !Array.isArray(profile.args) || profile.args.some(value => typeof value !== 'string')) throw new Error('外部代理的启用状态或启动参数无效。');
    if (profile.env !== undefined && (!profile.env || typeof profile.env !== 'object' || Array.isArray(profile.env)
      || Object.values(profile.env).some(value => typeof value !== 'string'))) throw new Error('外部代理环境变量必须是字符串键值对。');
  }
}
