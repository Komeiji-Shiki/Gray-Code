import type { RuntimeTool } from '@graycode/core';
import type { ExternalAgents } from './service';

export function externalAgentTool(service: ExternalAgents): RuntimeTool {
  return {
    declaration: { name: 'coding_agent', description: 'Work with a configured external ACP coding agent in this task\'s workspace. list shows profiles and sessions. create starts a session and can send the first prompt. prompt appends new input to an existing session. load restores a session without replaying earlier prompts. fork creates a separate session. configure applies mode or config IDs reported by the agent. events reads the recorded transcript. close ends the agent process you own, so keep the session open while background work still needs it. If an earlier operation ended with an unknown result, check it before starting a new one.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'create', 'prompt', 'load', 'fork', 'configure', 'close', 'events'] },
        profileId: { type: 'string' }, sessionId: { type: 'string' }, prompt: { type: 'string' },
        images: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative image files to attach to this prompt. Earlier images stay in the agent session.' },
        configId: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'boolean' }] }, modeId: { type: 'string' }, afterSequence: { type: 'integer', minimum: 0 },
      } } },
    effects: args => ['list', 'events'].includes(String(args.action)) ? ['workspace_read']
      : args.action === 'configure' ? ['process_execute', 'workspace_read', 'workspace_write', 'administration']
      : ['process_execute', 'workspace_read', 'workspace_write'],
    execute: (args, context) => service.execute(args, context),
  };
}
