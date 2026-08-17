/**
 * 存储适配器类型与接口（拆分自 storage.ts）。
 *
 * 把 IStorageAdapter 接口与所有存储相关的结果类型集中到本文件，storage.ts 通过
 * `export * from './storageTypes'` 再导出，保证既有 import 口径不变；各适配器实现
 * （memoryStorageAdapter / vscodeStorageAdapter / FileSystemStorageAdapter）直接引用本文件，
 * 避免与 storage.ts 形成运行时循环依赖。
 */

import type { SubAgentContextCompactionRecord } from '../../../shared/subAgentContextCompaction';
import type { Content, ConversationHistory, ConversationMetadata, HistorySnapshot } from './types';

export type StorageReadErrorCode = 'not_found' | 'parse_error' | 'io_error' | 'segment_missing';

export interface StorageReadResult<T> {
    value: T | null;
    errorCode?: StorageReadErrorCode;
    errorMessage?: string;
}

export interface StorageHistoryPage {
    total: number;
    startIndex: number;
    messages: ConversationHistory;
    format: 'paged' | 'legacy';
}

/**
 * 历史索引结构信息（HIS-11）。
 * 元数据完整性检查只需要索引结构（totalMessages/segments），不应解析段消息内容。
 */
export interface HistoryIndexInfo {
    /** 历史是否存在（segmented index 或 legacy 单文件） */
    exists: boolean;
    /** 历史索引是否可读（index 解析成功且段文件齐全；legacy 文件存在且 JSON 可解析） */
    readable: boolean;
    /** segmented 索引的消息总数（仅 segmented 时提供） */
    totalMessages?: number;
    /** segmented 索引的段数（仅 segmented 时提供） */
    segmentCount?: number;
    errorCode?: StorageReadErrorCode;
    errorMessage?: string;
}

export interface ConversationStorageIntegrity {
    historyExists: boolean;
    metadataExists: boolean;
    historyReadable: boolean;
    metadataReadable: boolean;
    historyErrorCode?: StorageReadErrorCode;
    metadataErrorCode?: StorageReadErrorCode;
    historyErrorMessage?: string;
    metadataErrorMessage?: string;
}

export interface ConversationStorageLocation {
    /**
     * 文件管理器应该 reveal 的 URI。
     *
     * 修改原因：历史页按钮需要打开真实存储位置，但不同存储格式可能是 legacy 单文件或 segmented 目录。
     * 修改方式：由存储适配器返回已解析好的 revealUri，而不是让 webview handler 猜路径。
     * 修改目的：路径规则保持单一来源，后续存储格式升级时只改适配器。
     */
    revealUri: any;
    /** 展示给前端或日志的人类可读路径 */
    displayPath: string;
    /** 是否定位到了该 conversation 的具体文件或目录 */
    exists: boolean;
    /** 文件缺失或使用兜底目录时的提示 */
    warning?: string;
}

/**
 * 存储适配器接口
 * 
 * 职责:
 * - ConversationManager 负责内存中的状态管理
 * - StorageAdapter 负责持久化(保存到文件、数据库等)
 */
export interface SubAgentTranscriptData {
    contents: Content[];
    /** provider 上下文总结/硬 fallback 的小型持久诊断记录。 */
    contextCompactions?: SubAgentContextCompactionRecord[];
    lastSentHistory?: Content[];
    /**
     * 新格式把 provider history 中可由 contents 重建的消息保存为索引，只内嵌无法匹配的消息。
     * 这样大型工具结果/图片不会在 contents 与 lastSentHistory 中重复保存两份。
     */
    lastSentHistoryProjection?: {
        version: 1;
        entries: Array<{ contentIndex: number } | { content: Content }>;
    };
}

export interface IStorageAdapter {
    /**
     * 保存对话历史(Gemini 格式)
     * @param conversationId 对话 ID
     * @param history 对话历史(Gemini Content[])
     */
    saveHistory(conversationId: string, history: ConversationHistory): Promise<void>;
    
    /**
     * 加载对话历史
     * @param conversationId 对话 ID
     * @returns Gemini 格式的历史记录
     */
    loadHistory(conversationId: string): Promise<ConversationHistory | null>;
    loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>>;
    loadHistoryPage(conversationId: string, options?: { beforeIndex?: number; offset?: number; limit?: number }): Promise<StorageReadResult<StorageHistoryPage>>;
    
    /**
     * 删除对话历史
     * @param conversationId 对话 ID
     */
    deleteHistory(conversationId: string): Promise<void>;
    
    /**
     * 列出所有对话 ID
     */
    listConversations(): Promise<string[]>;

    /**
     * 获取 conversations 目录的本地文件系统路径（供用量统计目录监听使用）；
     * 非文件系统存储（内存等）不实现，调用方退化全量扫描。
     */
    getConversationsDirFsPath?(): string | undefined;

    /** 子代理完整 transcript 独立存储，避免 Base64/长历史膨胀 conversation meta.json。 */
    saveSubAgentTranscript?(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string>;
    loadSubAgentTranscript?(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null>;
    deleteSubAgentTranscript?(conversationId: string, runId: string): Promise<void>;
    
    /**
     * 保存对话元数据
     * @param metadata 元数据
     */
    saveMetadata(metadata: ConversationMetadata): Promise<void>;
    
    /**
     * 加载对话元数据
     * @param conversationId 对话 ID
     */
    loadMetadata(conversationId: string): Promise<ConversationMetadata | null>;
    loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>>;
    getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity>;

    /**
     * 元数据损坏降级备份（可选）：把 {id}.meta.json 改名备份为
     * {id}.meta.json.corrupt-{Date.now()}（只保留一份，改名失败不抛错）。
     * ConversationManager.getMetadata 在 parse_error 降级时调用；
     * 未实现的适配器跳过备份直接返回 fallback 元数据。
     */
    backupCorruptMetadata?(conversationId: string): Promise<void>;

    /**
     * 获取对话在本地文件系统中的可定位位置。
     *
     * 修改原因：历史 UI 需要“在文件管理器中显示”对话记录，但 handler 不应该复制存储路径规则。
     * 修改方式：文件系统适配器实现该可选窄接口；非文件系统存储可不实现。
     * 修改目的：保持存储布局的单一来源，并让按钮在 legacy/segmented 两种格式下都可用。
     */
    getConversationStorageLocation?(conversationId: string): Promise<ConversationStorageLocation | null>;

    /**
     * 追加历史（append-only 尾段写入，HIS-01）。
     * 可选：未实现时调用方回退 saveHistory 全量重写。
     * 实现约定：最后段未满 200 条只追加该段，满了新建下一段；
     * 写临时尾段→原子替换→写临时 index→原子替换（index 是提交点）。
     */
    appendHistory?(conversationId: string, contents: ConversationHistory): Promise<void>;

    /**
     * 仅读取历史索引结构（不解析段消息内容，HIS-11）。
     * 可选：未实现时调用方回退 getConversationIntegrity。
     */
    getHistoryIndexInfo?(conversationId: string): Promise<HistoryIndexInfo>;

    /**
     * 仅读取历史索引的消息总数（不 stat 各段文件；updateSummary M3 钳制等轻量场景用，HIS-11）。
     * 可选：未实现时调用方回退 getHistoryIndexInfo（可能逐段 stat）。
     * 返回 null 表示索引不可读 / legacy / 不存在（钳制应跳过）。
     */
    getHistoryTotalMessages?(conversationId: string): Promise<number | null>;
    
    /**
     * 保存快照
     * @param snapshot 快照数据
     */
    saveSnapshot(snapshot: HistorySnapshot): Promise<void>;
    
    /**
     * 加载快照
     * @param snapshotId 快照 ID
     */
    loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null>;
    
    /**
     * 删除快照
     * @param snapshotId 快照 ID
     */
    deleteSnapshot(snapshotId: string): Promise<void>;
    
    /**
     * 列出对话的所有快照
     * @param conversationId 对话 ID
     */
    listSnapshots(conversationId: string): Promise<string[]>;
}
