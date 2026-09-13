import type { DebugBreakpoint, DebugConfiguration } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';

export function debugRequest(app: PlatformApplication, client: ClientSession, method: string, params: Record<string, any>) {
  app.requireOwner(client.actorId);
  const debug = app.debugging;
  switch (method) {
    case 'debug.adapters': return debug.adapters(client, params.refresh === true);
    case 'debug.settings': return debug.settings(client, params.workspaceId);
    case 'debug.configurations.save': return debug.saveConfigurations(client, params.workspaceId, params.configurations as DebugConfiguration[], params.expectedRevision);
    case 'debug.breakpoints.set': return debug.setBreakpoints(client, params.workspaceId, params.breakpoints as DebugBreakpoint[], params.expectedRevision);
    case 'debug.list': return debug.list(client, params.workspaceId);
    case 'debug.snapshot': return debug.snapshot(client, params.id);
    case 'debug.path': return debug.sourcePath(client, params.workspaceId, params.path);
    case 'debug.start': return debug.start(client, params.workspaceId, params.configuration as DebugConfiguration);
    case 'debug.stop': return debug.stop(client, params.id);
    case 'debug.restart': return debug.restart(client, params.id);
    case 'debug.terminal': return debug.openTerminal(client, params.id);
    case 'debug.request': return debug.request(client, params.id, params.command, params.arguments);
    default: throw new Error('未知调试操作。');
  }
}
