import type { RuntimeTool } from '@graycode/core';
import type { ExternalAgents } from './service';

export function externalAgentTool(service: ExternalAgents): RuntimeTool {
  return {
    declaration: { name: 'coding_agent', description: 'Use a configured external ACP coding agent in this task workspace. List profiles and sessions; create optionally sends the first prompt. Prompt only appends new input to an existing session. Load restores the agent session without replaying old prompts. Fork explicitly creates a separate session. Configure uses agent-provided mode/config IDs. Events reads the recorded transcript. Close ends the owned agent process; keep the session open when background work still needs it. Unknown execution results must be checked before starting a new operation.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'create', 'prompt', 'load', 'fork', 'configure', 'close', 'events'] },
        profileId: { type: 'string' }, sessionId: { type: 'string' }, prompt: { type: 'string' },
        images: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative image files to append to this prompt; previous images remain in the agent session.' },
        configId: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'boolean' }] }, modeId: { type: 'string' }, afterSequence: { type: 'integer', minimum: 0 },
      } } },
    effects: args => ['list', 'events'].includes(String(args.action)) ? ['workspace_read']
      : args.action === 'configure' ? ['process_execute', 'workspace_read', 'workspace_write', 'administration']
      : ['process_execute', 'workspace_read', 'workspace_write'],
    execute: (args, context) => service.execute(args, context),
  };
}
