/**
 * LimCode - 存储适配器接口
 * 
 * 存储格式说明:
 * - 对话历史: 完整的 Gemini Content[] 格式
 * - 文件命名: {conversationId}.json
 * - 元数据: 单独存储在 {conversationId}.meta.json
 * 
 * 这样设计的优势:
 * 1. 历史文件可直接用于 Gemini API
 * 2. 完整保留所有 Gemini 特性(函数调用、思考签名等)
 * 3. 元数据与历史分离,便于管理
 */

import { ConversationHistory, ConversationMetadata, HistorySnapshot } from './types';

export type StorageReadErrorCode = 'not_found' | 'parse_error' | 'io_error';

export interface StorageReadResult<T> {
    value: T | null;
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

/**
 * 存储适配器接口
 * 
 * 职责:
 * - ConversationManager 负责内存中的状态管理
 * - StorageAdapter 负责持久化(保存到文件、数据库等)
 */
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

/**
 * 内存存储适配器（用于测试或临时存储）
 */
export class MemoryStorageAdapter implements IStorageAdapter {
    private histories: Map<string, ConversationHistory> = new Map();
    private metadata: Map<string, ConversationMetadata> = new Map();
    private snapshots: Map<string, HistorySnapshot> = new Map();

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        // 深拷贝以避免引用问题
        this.histories.set(conversationId, JSON.parse(JSON.stringify(history)));
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const history = this.histories.get(conversationId);
        return history ? JSON.parse(JSON.stringify(history)) : null;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const value = await this.loadHistory(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        this.histories.delete(conversationId);
        this.metadata.delete(conversationId);
    }

    async listConversations(): Promise<string[]> {
        return Array.from(this.histories.keys());
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        this.metadata.set(metadata.id, JSON.parse(JSON.stringify(metadata)));
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const meta = this.metadata.get(conversationId);
        return meta ? JSON.parse(JSON.stringify(meta)) : null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const historyExists = this.histories.has(conversationId);
        const metadataExists = this.metadata.has(conversationId);
        return {
            historyExists,
            metadataExists,
            historyReadable: historyExists,
            metadataReadable: metadataExists,
            historyErrorCode: historyExists ? undefined : 'not_found',
            metadataErrorCode: metadataExists ? undefined : 'not_found',
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        this.snapshots.set(snapshot.id, JSON.parse(JSON.stringify(snapshot)));
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const snapshot = this.snapshots.get(snapshotId);
        return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        this.snapshots.delete(snapshotId);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const snapshots = Array.from(this.snapshots.values());
        return snapshots
            .filter(s => s.conversationId === conversationId)
            .map(s => s.id);
    }

    /**
     * 清空所有数据
     */
    clear(): void {
        this.histories.clear();
        this.metadata.clear();
        this.snapshots.clear();
    }
}

/**
 * VS Code ExtensionContext 存储适配器
 * 使用 VS Code 的 globalState 或 workspaceState
 */
export class VSCodeStorageAdapter implements IStorageAdapter {
    constructor(
        private context: any // vscode.ExtensionContext
    ) {}

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const key = `limcode.history.${conversationId}`;
        await this.context.globalState.update(key, history);
        
        // 更新元数据的 updatedAt
        const metaKey = `limcode.meta.${conversationId}`;
        const meta = this.context.globalState.get(metaKey) as ConversationMetadata | undefined;
        if (meta) {
            meta.updatedAt = Date.now();
            await this.context.globalState.update(metaKey, meta);
        }
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const key = `limcode.history.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationHistory | undefined) || null;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const value = await this.loadHistory(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        const historyKey = `limcode.history.${conversationId}`;
        const metaKey = `limcode.meta.${conversationId}`;
        await this.context.globalState.update(historyKey, undefined);
        await this.context.globalState.update(metaKey, undefined);
    }

    async listConversations(): Promise<string[]> {
        const keys = this.context.globalState.keys();
        return keys
            .filter((k: string) => k.startsWith('limcode.history.'))
            .map((k: string) => k.replace('limcode.history.', ''));
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const key = `limcode.meta.${metadata.id}`;
        await this.context.globalState.update(key, metadata);
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const key = `limcode.meta.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationMetadata | undefined) || null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const history = await this.loadHistoryWithStatus(conversationId);
        const metadata = await this.loadMetadataWithStatus(conversationId);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const key = `limcode.snapshot.${snapshot.id}`;
        await this.context.globalState.update(key, snapshot);
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const key = `limcode.snapshot.${snapshotId}`;
        return (this.context.globalState.get(key) as HistorySnapshot | undefined) || null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const key = `limcode.snapshot.${snapshotId}`;
        await this.context.globalState.update(key, undefined);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const keys = this.context.globalState.keys();
        const snapshotKeys = keys.filter((k: string) => k.startsWith('limcode.snapshot.'));
        
        const snapshots: string[] = [];
        for (const key of snapshotKeys) {
            const snapshot = this.context.globalState.get(key) as HistorySnapshot | undefined;
            if (snapshot && snapshot.conversationId === conversationId) {
                snapshots.push(snapshot.id);
            }
        }
        return snapshots;
    }
}

/**
 * 文件系统存储适配器（使用 VS Code workspace.fs API）
 * 
 * 文件结构:
 * - {baseDir}/conversations/{conversationId}.json        # 对话历史(Gemini 格式)
 * - {baseDir}/conversations/{conversationId}.meta.json   # 对话元数据
 * - {baseDir}/snapshots/{snapshotId}.json                # 快照
 */
export class FileSystemStorageAdapter implements IStorageAdapter {
    constructor(
        private vscode: any, // VS Code API
        private baseDir: string // 存储目录的 URI
    ) {}

    private getHistoryPath(conversationId: string): any {
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.json`
        );
    }

    private getMetadataPath(conversationId: string): any {
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.meta.json`
        );
    }

    private getSnapshotPath(snapshotId: string): any {
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'snapshots',
            `${snapshotId}.json`
        );
    }

    private isNotFoundError(error: any): boolean {
        const code = String(error?.code || '');
        if (code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT') {
            return true;
        }
        const name = String(error?.name || '');
        if (name.includes('EntryNotFound')) {
            return true;
        }
        const message = String(error?.message || '').toLowerCase();
        return (
            message.includes('entrynotfound') ||
            message.includes('enoent') ||
            message.includes('file not found')
        );
    }

    private async readJsonFile<T>(uri: any): Promise<StorageReadResult<T>> {
        try {
            const content = await this.vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            try {
                return { value: JSON.parse(text) as T };
            } catch (parseError: any) {
                return {
                    value: null,
                    errorCode: 'parse_error',
                    errorMessage: parseError?.message || 'Failed to parse JSON',
                };
            }
        } catch (error: any) {
            if (this.isNotFoundError(error)) {
                return {
                    value: null,
                    errorCode: 'not_found',
                    errorMessage: error?.message,
                };
            }
            return {
                value: null,
                errorCode: 'io_error',
                errorMessage: error?.message || String(error),
            };
        }
    }

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const uri = this.getHistoryPath(conversationId);
        const content = JSON.stringify(history, null, 2);
        await this.vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        
        // 更新元数据的 updatedAt
        try {
            const meta = await this.loadMetadata(conversationId);
            if (meta) {
                meta.updatedAt = Date.now();
                await this.saveMetadata(meta);
            }
        } catch {
            // 忽略元数据更新失败
        }
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const result = await this.loadHistoryWithStatus(conversationId);
        return result.value;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const uri = this.getHistoryPath(conversationId);
        return await this.readJsonFile<ConversationHistory>(uri);
    }

    async deleteHistory(conversationId: string): Promise<void> {
        try {
            const historyUri = this.getHistoryPath(conversationId);
            const metaUri = this.getMetadataPath(conversationId);
            await this.vscode.workspace.fs.delete(historyUri);
            await this.vscode.workspace.fs.delete(metaUri);
        } catch {
            // 文件不存在，忽略
        }
    }

    async listConversations(): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'conversations'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);
            return entries
                .filter(([name, type]: [string, number]) => 
                    type === 1 && name.endsWith('.json') && !name.endsWith('.meta.json')
                )
                .map(([name]: [string, number]) => name.replace('.json', ''));
        } catch {
            return [];
        }
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const uri = this.getMetadataPath(metadata.id);
        const content = JSON.stringify(metadata, null, 2);
        await this.vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.loadMetadataWithStatus(conversationId);
        return result.value;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const uri = this.getMetadataPath(conversationId);
        return await this.readJsonFile<ConversationMetadata>(uri);
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const [history, metadata] = await Promise.all([
            this.loadHistoryWithStatus(conversationId),
            this.loadMetadataWithStatus(conversationId),
        ]);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const uri = this.getSnapshotPath(snapshot.id);
        const content = JSON.stringify(snapshot, null, 2);
        await this.vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        try {
            const uri = this.getSnapshotPath(snapshotId);
            const content = await this.vscode.workspace.fs.readFile(uri);
            return JSON.parse(Buffer.from(content).toString('utf8'));
        } catch {
            return null;
        }
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        try {
            const uri = this.getSnapshotPath(snapshotId);
            await this.vscode.workspace.fs.delete(uri);
        } catch {
            // 文件不存在，忽略
        }
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'snapshots'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);
            
            const snapshots: string[] = [];
            for (const [name, type] of entries) {
                if (type === 1 && name.endsWith('.json')) {
                    const snapshotId = name.replace('.json', '');
                    const snapshot = await this.loadSnapshot(snapshotId);
                    if (snapshot && snapshot.conversationId === conversationId) {
                        snapshots.push(snapshotId);
                    }
                }
            }
            return snapshots;
        } catch {
            return [];
        }
    }
}
