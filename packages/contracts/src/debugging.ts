import type { DebugAdapterDefinition } from './development';

export interface DebugConfiguration {
  id: string; name: string; adapterId: string; request: 'launch' | 'attach';
  program?: string; cwd?: string; args?: string[]; env?: Record<string, string | null>;
  runtimeExecutable?: string; host?: string; port?: number;
  console?: 'internalConsole' | 'integratedTerminal';
  options?: Record<string, unknown>;
}
/** DAP 的行列从 1 开始；与语言服务的零起点位置分开保存。 */
export interface DebugBreakpoint {
  id: string; path: string; line: number; column?: number; enabled: boolean;
  condition?: string; hitCondition?: string; logMessage?: string;
}
export interface DebugWorkspaceState { configurations: DebugConfiguration[]; breakpoints: DebugBreakpoint[]; configurationRevision: number | null; breakpointRevision: number | null }
export interface DebugAdapterInfo {
  id: string; name: string; source: 'bundled' | 'system' | 'custom'; available: boolean;
  requirement?: string; documentationUrl?: string; configurationTemplate?: DebugAdapterDefinition;
}
export interface DebugSessionInfo {
  id: string; rootId: string; parentId?: string; workspaceId: string; configurationId: string;
  name: string; adapterId: string; request: 'launch' | 'attach';
  status: 'starting' | 'running' | 'stopped' | 'terminated' | 'failed';
  threadId?: number; reason?: string; description?: string; error?: string; exitCode?: number; processId?: number; terminalId?: string;
  capabilities: Record<string, unknown>;
}
export interface DebugSource { name?: string; path?: string; sourceReference?: number }
export interface DebugStackFrame { id: number; name: string; source?: DebugSource; line: number; column: number }
export interface DebugScope { name: string; variablesReference: number; expensive: boolean }
export interface DebugVariable { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string; namedVariables?: number; indexedVariables?: number }
export interface DebugBreakpointResult { id?: number; verified: boolean; message?: string; line?: number; column?: number; source?: DebugSource }
export interface DebugOutput { sequence: number; category: string; output: string; source?: DebugSource; line?: number; variablesReference?: number; group?: string }
