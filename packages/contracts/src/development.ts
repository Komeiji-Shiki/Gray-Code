export interface LanguageServerDefinition {
  id: string;
  name: string;
  languages: string[];
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}
export interface DebugAdapterDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
  transport: 'stdio' | 'tcp';
  port?: number;
}
export interface DevelopmentSettings {
  disabledLanguageServers?: string[];
  languageServers?: LanguageServerDefinition[];
  debugAdapters?: DebugAdapterDefinition[];
}
export interface LanguageSessionInfo {
  id: string; workspaceId: string; serverId: string; name: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  error?: string;
}
export interface SourcePosition { line: number; character: number }
export interface SourceRange { start: SourcePosition; end: SourcePosition }
export interface LanguageDiagnostic {
  range: SourceRange; message: string; severity?: number; source?: string; code?: string | number; tags?: number[];
  relatedInformation?: Array<{ location: { uri: string; range: SourceRange }; message: string }>;
  data?: unknown;
}
