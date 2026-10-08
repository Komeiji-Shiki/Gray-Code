import type { RuntimeTool } from '@graycode/core';
import type { ExternalAgents } from './service';

export function externalAgentTool(service: ExternalAgents): RuntimeTool {
  return {
    declaration: { name: 'coding_agent', description: 'Work with a configured external ACP coding agent in this task\'s workspace. list shows profiles and sessions. create starts a session and can send the first prompt. prompt appends new input to an existing session. load restores a session without replaying earlier prompts. fork creates a separate session. configure applies mode or config IDs reported by the agent. events reads the recorded transcript. close ends the agent process you own, so keep the session open while background work still needs it. If an earlier operation ended with an unknown result, check it before starting a new one.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'create', 'prompt', 'load', 'fork', 'configure', 'close', 'events'] },
        profileId: { type: 'string', description: 'Configured profile ID returned by list. Used for create; it may be omitted when exactly one profile is enabled. fork inherits the source profile.' },
        sessionId: { type: 'string', description: 'GrayCode session.id returned by create, fork, or list. Required for prompt, load, fork, configure, close, and events.' },
        prompt: { type: 'string', description: 'New input to send to the agent. Required and non-empty for prompt; optional for create. Send only the new instruction because the agent keeps its session history.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative image files to attach to this prompt. Earlier images stay in the agent session.' },
        configId: { type: 'string', description: 'For configure: an ID from session.configOptions. Supply value with the type reported by that option.' },
        value: { oneOf: [{ type: 'string' }, { type: 'boolean' }], description: 'For configure with configId: the selected string value or boolean setting.' },
        modeId: { type: 'string', description: 'For configure: an ID from session.modes.availableModes. Supply modeId to change mode, or configId and value to change one option.' },
        afterSequence: { type: 'integer', minimum: 0, description: 'For events: return up to 100 recorded events whose sequence is greater than this value. Start at 0; continue with the last returned event.sequence while hasMore is true.' },
      } } },
    effects: args => ['list', 'events'].includes(String(args.action)) ? ['workspace_read']
      : args.action === 'configure' ? ['process_execute', 'workspace_read', 'workspace_write', 'administration']
      : ['process_execute', 'workspace_read', 'workspace_write'],
    execute: (args, context) => service.execute(args, context),
  };
}
