/** 存储层的记忆合同，不依赖工具、界面或文件格式。 */
export interface MemoryScopeDefinition { id: string; actorId: string; workspaceKey?: string }
export interface MemoryScopeState extends MemoryScopeDefinition { length: number; revision: number }
export interface MemoryEntry { id: number; date: string; text: string; source?: Record<string, unknown> }
export interface MemorySummary { lo: number; hi: number; text: string }
export type MemoryMutation =
  | { type: 'append'; entries: Omit<MemoryEntry, 'id'>[] }
  | { type: 'update'; id: number; text: string }
  | { type: 'delete'; ids: number[] }
  | { type: 'truncate'; keep: number }
  | { type: 'summary.put'; lo: number; hi: number; text: string }
  | { type: 'summary.drop'; lo: number; hi: number }
  | { type: 'undo'; revision: number };
export interface MemoryWrite {
  scope: MemoryScopeDefinition;
  expectedRevision: number;
  mutation: MemoryMutation;
  source?: Record<string, unknown>;
}
export interface MemoryWriteResult { state: MemoryScopeState; changed: boolean; removed: number; dropped: Array<[number, number]>; appendedAt?: number }
export interface MemoryRevision { revision: number; kind: MemoryMutation['type'] | 'import'; timestamp: number; source?: Record<string, unknown> }
export interface MemoryImportPublish {
  staging: MemoryScopeDefinition; target: MemoryScopeDefinition; sourceKey: string; fingerprint: string; entries: number;
  config?: { id: string; value: Record<string, number> };
}
export interface MemoryImportBatch {
  staging: MemoryScopeDefinition; sourceKey: string; fingerprint: string; expectedRevision: number;
  entries?: Omit<MemoryEntry, 'id'>[]; summaries?: MemorySummary[];
}
