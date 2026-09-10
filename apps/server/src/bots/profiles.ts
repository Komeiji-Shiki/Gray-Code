import { createHash } from 'node:crypto';
import type { AgentDefinition, DiscordReplyProfile } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { configuredAgent } from '../settings/agent';

interface CapturedBotAgent { actorId: string; conversationId: string; agent: AgentDefinition }
const namespace = 'bot-agent-profiles';

export async function captureBotAgent(app: PlatformApplication, actorId: string, conversationId: string, profile: DiscordReplyProfile): Promise<AgentDefinition> {
  const base = app.settings.snapshot().settings.agents.find(agent => agent.id === profile.agentId);
  if (!base) throw new Error('Bot 的智能体配置不存在，请在桌面管理页重新选择。');
  const agent = configuredAgent(app, base);
  if (profile.providerId && profile.providerId !== agent.providerId) { agent.providerId = profile.providerId; delete agent.modelId; }
  if (profile.modelId) agent.modelId = profile.modelId;
  if (profile.promptModeId) agent.promptModeId = profile.promptModeId;
  if (profile.toolsEnabled === false) agent.toolNames = [];
  if (profile.maxIterations !== undefined) agent.maxIterations = profile.maxIterations;
  const id = 'bot_' + createHash('sha256').update(JSON.stringify({ actorId, conversationId, agent })).digest('hex').slice(0, 40);
  agent.id = id;
  if (!await app.storage.getRecord(namespace, id)) await app.storage.putRecord({ namespace, id, ownerId: conversationId,
    value: { actorId, conversationId, agent } satisfies CapturedBotAgent });
  return agent;
}
export async function resolveBotAgent(app: PlatformApplication, id: string, actorId?: string, conversationId?: string): Promise<AgentDefinition | null> {
  if (!id.startsWith('bot_') || !actorId || !conversationId) return null;
  const value = await app.storage.getRecord(namespace, id) as CapturedBotAgent | null;
  return value?.actorId === actorId && value.conversationId === conversationId ? structuredClone(value.agent) : null;
}
