export type LongMemoryKind = 'fact' | 'preference' | 'experience' | 'project' | 'procedure' | 'event' | 'summary';
export type LongMemoryOrigin = 'user' | 'model' | 'tool' | 'fiction' | 'import';
export type LongMemoryConfidence = 'confirmed' | 'inferred' | 'disputed';

/** 账号与剧情域由宿主绑定，模型只能在已经授权的范围内选择主题。 */
export interface LongMemoryScope {
  id: string; actorId: string; kind: 'personal' | 'workspace' | 'group'; key?: string; realm: string;
}
export interface LongMemoryScopeState extends LongMemoryScope { revision: number; invalidation: number }
export interface LongMemoryReference { kind: 'source' | 'record'; id: string; version: number }
export interface LongMemorySource {
  id: string; version: number; scopeId: string; origin: LongMemoryOrigin; text: string;
  recordedAt: number; eventAt?: number;
  reference?: { conversationId?: string; messageId?: string; toolCallId?: string; resourceId?: string; label?: string };
}
export interface LongMemoryRecord {
  id: string; version: number; scopeId: string; kind: LongMemoryKind; origin: LongMemoryOrigin;
  confidence: LongMemoryConfidence; subject: string; attribute?: string; value?: string;
  text: string; topic: string[]; entities: string[]; recordedAt: number;
  validFrom: number; validTo?: number; eventAt?: number;
  dependencies: LongMemoryReference[]; supersedes: string[];
}
export interface LongMemoryVector { model: string; dimensions: number; values: number[] }
export type LongMemorySourceInput = Omit<LongMemorySource, 'scopeId' | 'version'> & { expectedVersion: number };
export type LongMemoryRecordInput = Omit<LongMemoryRecord, 'scopeId' | 'version'> & { expectedVersion: number; vector?: LongMemoryVector };
export interface LongMemoryWrite {
  scope: LongMemoryScope; sources?: LongMemorySourceInput[]; records?: LongMemoryRecordInput[];
  remove?: Array<{ kind: 'source' | 'record'; id: string; expectedVersion?: number; action: 'delete' | 'retract' }>;
}
export interface LongMemoryWriteResult {
  state: LongMemoryScopeState; sources: LongMemorySource[]; records: LongMemoryRecord[]; removed: number;
}
export interface LongMemoryQuery {
  scopes: LongMemoryScope[]; text?: string; topic?: string[]; kinds?: LongMemoryKind[];
  asOf: number; knownAt: number; confirmedOnly?: boolean;
  limit: number; tokenBudget: number; vector?: LongMemoryVector;
}
export interface LongMemoryHit {
  record: LongMemoryRecord; score: number; reasons: string[]; conflicts: string[];
}
export interface LongMemoryRecall {
  hits: LongMemoryHit[]; estimatedTokens: number; method: 'keyword' | 'hybrid';
  vectorModel?: string; states: LongMemoryScopeState[]; truncated: boolean;
}
export interface LongMemoryTopic {
  scopeId: string; path: string[]; records: number; summaries: Array<{ id: string; version: number; text: string }>;
}
export interface LongMemoryRead {
  query: LongMemoryQuery; references: Array<{ scopeId: string; id: string; version?: number }>;
  includeSources?: boolean;
}
export interface LongMemoryReadResult {
  records: LongMemoryRecord[]; sources: LongMemorySource[];
  unavailable: Array<{ scopeId: string; id: string; version?: number }>; estimatedTokens: number;
}
export interface LongMemoryTombstone {
  scopeId: string; kind: 'source' | 'record'; id: string; action: 'delete' | 'retract'; at: number;
}
export interface LongMemoryArchive {
  format: 'graycode-long-memory'; version: 1; createdAt: number; scopes: LongMemoryScopeState[];
  sources: LongMemorySource[]; records: LongMemoryRecord[]; tombstones: LongMemoryTombstone[];
}
export interface LongMemoryJob {
  id: string; scopeId: string; kind: 'extract' | 'summarize' | 'embed';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  dependencies: LongMemoryReference[]; providerId: string; model?: string;
  createdAt: number; updatedAt: number; attempts: number; error?: string;
  usage?: { input?: number; output?: number; thoughts?: number; cacheRead?: number; total?: number };
}
export interface LongMemoryPolicy {
  enabled: boolean; automaticExtraction: boolean; providerId?: string; model?: string;
  recallTokens: number; recallLimit: number; extractionOutputTokens: number;
  embedding?: { url: string; model: string; credentialRef?: string; dimensions?: number };
}
