export type LongMemoryKind = 'fact' | 'preference' | 'experience' | 'project' | 'procedure' | 'event' | 'summary';
export type LongMemoryOrigin = 'user' | 'model' | 'tool' | 'fiction' | 'import';
export type LongMemoryConfidence = 'confirmed' | 'inferred' | 'disputed';

/** 账号与剧情域由宿主绑定，模型只能在已经授权的范围内选择主题。 */
export interface LongMemoryScope {
  id: string; actorId: string; kind: 'personal' | 'workspace' | 'group' | 'library'; key?: string; realm: string;
}
export interface LongMemoryScopeState extends LongMemoryScope { revision: number; invalidation: number; hasRecords?:boolean }
export interface LongMemoryReference { kind: 'source' | 'record'; id: string; version: number }
export interface LongMemorySource {
  id: string; version: number; scopeId: string; origin: LongMemoryOrigin; text: string;
  recordedAt: number; eventAt?: number;
  /** 后台提取输入的稳定引用；摘录可独立删除，并阻止旧输入再次生成该内容。 */
  upstream?:{id:string;version:number};
  reference?: { conversationId?: string; messageId?: string; toolCallId?: string; resourceId?: string; speakerActorId?: string; label?: string };
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
  asOf: number; knownAt: number; confirmedOnly?: boolean; includeSummaries?:boolean;
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
export interface LongMemoryTopicQuery extends LongMemoryQuery { cursor?: string }
export interface LongMemoryTopicPage {
  topics: LongMemoryTopic[]; estimatedTokens: number; truncated: boolean;
  nextCursor?: string; requiredTokenBudget?: number;
}
export interface LongMemoryGraphNode {
  key: string; id: string; scopeId: string; version: number; type: 'record' | 'source';
  side: 'dependency' | 'selected' | 'dependent'; title: string; preview: string;
  kind: LongMemoryKind | LongMemoryOrigin; active: boolean; confidence?: LongMemoryConfidence;
}
export interface LongMemoryGraph {
  root: string; nodes: LongMemoryGraphNode[]; edges: Array<{ from: string; to: string }>;
  truncated: boolean;
}
export interface LongMemoryRead {
  query: LongMemoryQuery; references: Array<{ scopeId: string; id: string; version?: number }>;
  includeSources?: boolean;
}
export interface LongMemoryReadResult {
  records: LongMemoryRecord[]; sources: LongMemorySource[];
  unavailable: Array<{ scopeId: string; id: string; version?: number }>; estimatedTokens: number;
  /** 区分预算省略与内容失效，调用方可提高预算或减少同批编号后重读。 */
  omitted?: Array<{ kind: 'record' | 'source'; scopeId: string; id: string; version?: number; reason: 'token_budget' | 'record_limit'; estimatedTokens: number }>;
  truncated?: boolean;
}
export interface LongMemoryTombstone {
  scopeId: string; kind: 'source' | 'record'; id: string; action: 'delete' | 'retract'; at: number;
  /** 只保留原消息定位，不保留被删除摘录。用于阻止历史工具或摘要再次发送旧内容。 */
  reference?: LongMemorySource['reference'];
}
export interface LongMemoryArchive {
  format: 'graycode-long-memory'; version: 1; createdAt: number; scopes: LongMemoryScopeState[];
  sources: LongMemorySource[]; records: LongMemoryRecord[]; tombstones: LongMemoryTombstone[];
}
export interface LongMemoryJob {
  id: string; scopeId: string; kind: 'extract' | 'summarize' | 'embed';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  dependencies: LongMemoryReference[]; providerId: string; model?: string;
  actorId?: string; conversationId?: string;
  topic?:string[];targetId?:string;expectedVersion?:number;
  createdAt: number; updatedAt: number; attempts: number; error?: string;
  usage?: { input?: number; output?: number; thoughts?: number; cacheRead?: number; total?: number;servedModel?:string;elapsedMs?:number };
}
export interface LongMemoryPolicy {
  enabled: boolean; automaticExtraction: boolean; providerId?: string; model?: string;
  automaticScopes?: Array<Exclude<LongMemoryScope['kind'], 'library'>>;
  recallTokens: number; recallLimit: number; extractionOutputTokens: number;
  embedding?: { url: string; model: string; credentialRef?: string; dimensions?: number; queryPrefix?:string;documentPrefix?:string };
}
