import type { ProviderDefinition, ProviderProtocol } from '../packages/contracts/src/providers';

// 未单独声明模型能力时，沿用渠道设置页已有的协议选项。
const protocolLevels: Record<ProviderProtocol, readonly string[]> = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'openai-responses': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  gemini: ['minimal', 'low', 'medium', 'high'],
  'gemini-interactions': ['minimal', 'low', 'medium', 'high'],
};

/** 渠道设置页为协议提供的固定档位；不在其中的强度由设置页按自定义值保存。 */
export function protocolReasoningLevels(protocol: ProviderProtocol): readonly string[] { return protocolLevels[protocol]; }

export function reasoningLevelsForModel(profile: ProviderDefinition, model: string): string[] {
  const capabilities = { ...profile.capabilities, ...profile.models.find(item => item.id === model)?.capabilities };
  if (capabilities.reasoningParameter === 'disabled') return [];
  if (capabilities.reasoningLevels.length) return [...new Set(capabilities.reasoningLevels)];
  return capabilities.reasoningParameter === 'protocol_default' ? [...protocolLevels[profile.protocol]] : [];
}
