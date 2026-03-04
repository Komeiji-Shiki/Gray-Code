/**
 * LimCode - 瀵硅瘽鍘嗗彶绠＄悊鍣?
 *
 * 鏍稿績鑱岃矗:
 * - 绠＄悊 Gemini 鏍煎紡鐨勫璇濆巻鍙?
 * - 鎻愪緵绫诲瀷瀹夊叏鐨勬搷浣?API
 * - 缁存姢瀵硅瘽鍏冩暟鎹?
 * - 鏀寔鎸佷箙鍖栧瓨鍌?
 *
 * 瀛樺偍鏍煎紡:
 * - 鍘嗗彶: 瀹屾暣鐨?Gemini Content[] 鏁扮粍
 * - 鍏冩暟鎹? 瀵硅瘽鏍囬銆佸垱寤烘椂闂寸瓑
 * - 蹇収: 鍘嗗彶鐨勬椂闂寸偣鍓湰
 */

import { t } from '../../i18n';
import {
    ConversationHistory,
    ConversationMetadata,
    Content,
    ContentPart,
    MessagePosition,
    MessageFilter,
    HistorySnapshot,
    ConversationStats
} from './types';
import type { ConversationStorageIntegrity, IStorageAdapter } from './storage';
import { cleanFunctionResponseForAPI } from './helpers';

/**
 * 澶氭ā鎬佽兘鍔涳紙鐢ㄤ簬杩囨护鍘嗗彶涓殑澶氭ā鎬佹暟鎹級
 */
export interface MultimodalCapability {
    /** 鏄惁鏀寔鍥剧墖 */
    supportsImages: boolean;
    /** 鏄惁鏀寔鏂囨。锛圥DF锛?*/
    supportsDocuments: boolean;
    /** 鏄惁鏀寔鍥炰紶澶氭ā鎬佹暟鎹埌鍘嗗彶璁板綍 */
    supportsHistoryMultimodal: boolean;
}

/**
 * 鑾峰彇鍘嗗彶鐨勯€夐」
 */
export interface GetHistoryOptions {
    /** 鏄惁鍖呭惈褰撳墠杞鐨勬€濊€冨唴瀹癸紙榛樿 false锛?*/
    includeThoughts?: boolean;
    
    /** 鏄惁鍙戦€佸巻鍙叉€濊€冨唴瀹癸紙榛樿 false锛?*/
    sendHistoryThoughts?: boolean;
    
    /** 鏄惁鍙戦€佸巻鍙叉€濊€冪鍚嶏紙榛樿 false锛?*/
    sendHistoryThoughtSignatures?: boolean;

    /** 鏄惁鍙戦€佸綋鍓嶈疆娆＄殑鎬濊€冨唴瀹癸紙榛樿鏍规嵁娓犻亾鍐冲畾锛?*/
    sendCurrentThoughts?: boolean;

    /** 鏄惁鍙戦€佸綋鍓嶈疆娆＄殑鎬濊€冪鍚嶏紙榛樿鏍规嵁娓犻亾鍐冲畾锛?*/
    sendCurrentThoughtSignatures?: boolean;
    
    /** 娓犻亾绫诲瀷锛岀敤浜庨€夋嫨瀵瑰簲鏍煎紡鐨勭鍚?*/
    channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    
    /**
     * 澶氭ā鎬佽兘鍔涳紙鍙€夛級
     *
     * 濡傛灉鎻愪緵锛屽皢鏍规嵁鑳藉姏杩囨护鍘嗗彶涓殑澶氭ā鎬佹暟鎹細
     * - 濡傛灉涓嶆敮鎸?supportsHistoryMultimodal锛屽垯杩囨护鎵€鏈夊巻鍙蹭腑鐨?inlineData
     * - 濡傛灉涓嶆敮鎸?supportsDocuments锛屽垯杩囨护鏂囨。绫诲瀷鐨?inlineData
     * - 濡傛灉涓嶆敮鎸?supportsImages锛屽垯杩囨护鍥剧墖绫诲瀷鐨?inlineData
     */
    multimodalCapability?: MultimodalCapability;
    
    /**
     * 鍘嗗彶鎬濊€冨洖鍚堟暟
     *
     * 鎺у埗鍙戦€佸灏戣疆闈炴渶鏂板洖鍚堢殑鍘嗗彶瀵硅瘽鎬濊€冿細
     * - `-1`: 鍙戦€佸叏閮ㄥ巻鍙插洖鍚堢殑鎬濊€冿紙榛樿鍊硷級
     * - `0`: 涓嶅彂閫佷换浣曞巻鍙插洖鍚堢殑鎬濊€?
     * - 姝ｆ暟 `n`: 鍙戦€佹渶杩?n 杞潪鏈€鏂板洖鍚堢殑鎬濊€冿紙濡?1 琛ㄧず鍙彂閫佸€掓暟绗簩鍥炲悎锛?
     *
     * 浠呭湪 sendHistoryThoughts 鎴?sendHistoryThoughtSignatures 涓?true 鏃剁敓鏁?
     */
    historyThinkingRounds?: number;
    
    /**
     * 璧峰绱㈠紩锛堝彲閫夛級
     *
     * 浠庢寚瀹氱储寮曞紑濮嬭幏鍙栧巻鍙诧紝鐢ㄤ簬涓婁笅鏂囪鍓€?
     * 榛樿涓?0锛堜粠澶村紑濮嬶級銆?
     */
    startIndex?: number;
}

/**
 * 瀵硅瘽绠＄悊鍣?
 *
 * 鐗圭偣:
 * - 瀹屾暣鏀寔 Gemini 鏍煎紡鐨勬墍鏈夌壒鎬?
 * - 鑷姩缁存姢鍏冩暟鎹?
 * - 鏀寔鎬濊€冪鍚嶃€佸嚱鏁拌皟鐢ㄧ瓑楂樼骇鐗规€?
 * - 鍙洿鎺ュ皢鍘嗗彶鍙戦€佺粰 Gemini API
 * - 鏃犲唴瀛樼紦瀛橈紝姣忔鎿嶄綔鐩存帴璇诲啓瀛樺偍锛岀‘淇濇暟鎹竴鑷存€?
 */
export class ConversationManager {
    constructor(private storage: IStorageAdapter) {}

    private resolveIntegrityStatus(
        integrity: ConversationStorageIntegrity | null
    ): ConversationMetadata['integrityStatus'] | undefined {
        if (!integrity) return undefined;
        if (!integrity.historyExists) return 'history_missing';
        if (!integrity.historyReadable) return 'history_corrupt';
        if (!integrity.metadataExists) return 'meta_missing';
        if (!integrity.metadataReadable) return 'meta_corrupt';
        return 'ok';
    }

    private async loadMetadataForWrite(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        if (result.value) {
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            return null;
        }
        throw new Error(
            `Failed to load conversation metadata (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }

    private createFallbackMetadata(
        conversationId: string,
        history: ConversationHistory | null
    ): ConversationMetadata {
        const timestamps = (history || [])
            .map(item => item.timestamp)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const now = Date.now();
        const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now;
        const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now;

        return {
            id: conversationId,
            title: t('modules.conversation.defaultTitle', { conversationId }),
            createdAt,
            updatedAt,
            custom: {},
        };
    }

    /**
     * 瑙勮寖鍖栧巻鍙诧細琛ラ綈鏈搷搴旂殑宸ュ叿璋冪敤锛坮ejected + functionResponse 鎻掑叆锛夛紝骞跺湪蹇呰鏃跺啓鍥炲瓨鍌ㄣ€?
     *
     * 娉ㄦ剰锛氭杩囩▼浼氭敼鍙?history 鐨勯暱搴︼紝浠庤€屾敼鍙樻秷鎭?index銆?
     * 鍓嶇渚濊禆 index 杩涜鍒犻櫎/閲嶈瘯绛夋搷浣滐紝鍥犳蹇呴』鍦ㄨ繑鍥炲墠瀹屾垚璇ヨ鑼冨寲銆?
     */
    private async normalizeHistoryForDisplay(conversationId: string, history: ConversationHistory): Promise<ConversationHistory> {
        // 鏀堕泦鎵€鏈?functionResponse 鐨?ID
        const respondedToolCallIds = new Set<string>();
        for (const message of history) {
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.functionResponse?.id) {
                        respondedToolCallIds.add(part.functionResponse.id);
                    }
                }
            }
        }

        // 鏀堕泦鏈搷搴旂殑宸ュ叿璋冪敤锛岃褰曞畠浠墍鍦ㄧ殑娑堟伅绱㈠紩
        const unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string }>> = new Map();
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.functionCall && part.functionCall.id) {
                        // 濡傛灉宸ュ叿璋冪敤娌℃湁瀵瑰簲鐨勫搷搴旓紝涓旇繕娌℃湁琚爣璁颁负 rejected
                        if (!respondedToolCallIds.has(part.functionCall.id) && !part.functionCall.rejected) {
                            part.functionCall.rejected = true;
                            const calls = unresolvedCallsByIndex.get(i) || [];
                            calls.push({
                                id: part.functionCall.id,
                                name: part.functionCall.name || 'unknown'
                            });
                            unresolvedCallsByIndex.set(i, calls);
                        }
                    }
                }
            }
        }

        // 濡傛灉鏈夋湭鍝嶅簲鐨勫伐鍏疯皟鐢紝鍦ㄥ伐鍏疯皟鐢ㄦ秷鎭揣鎺ュ悗闈㈡彃鍏?functionResponse
        // 浠庡悗寰€鍓嶆彃鍏ヤ互閬垮厤绱㈠紩鍋忕Щ闂
        if (unresolvedCallsByIndex.size > 0) {
            const sortedIndices = Array.from(unresolvedCallsByIndex.keys()).sort((a, b) => b - a);

            for (const messageIndex of sortedIndices) {
                const calls = unresolvedCallsByIndex.get(messageIndex)!;
                const rejectedResponseParts: ContentPart[] = calls.map(call => ({
                    functionResponse: {
                        name: call.name,
                        id: call.id,
                        response: {
                            success: false,
                            error: t('modules.api.chat.errors.userRejectedTool'),
                            rejected: true
                        }
                    }
                }));

                // 鍦ㄥ伐鍏疯皟鐢ㄦ秷鎭殑绱ф帴鍚庨潰鎻掑叆
                history.splice(messageIndex + 1, 0, {
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                });
            }

            await this.storage.saveHistory(conversationId, history);
        }

        return history;
    }

    // ==================== 瀵硅瘽绠＄悊 ====================

    /**
     * 鍒涘缓鏂板璇?
     * @param conversationId 瀵硅瘽 ID
     * @param title 瀵硅瘽鏍囬
     * @param workspaceUri 宸ヤ綔鍖?URI锛堝彲閫夛級
     */
    async createConversation(conversationId: string, title?: string, workspaceUri?: string): Promise<void> {
        // 妫€鏌ュ瓨鍌ㄤ腑鏄惁宸插瓨鍦?
        const existing = await this.storage.loadHistoryWithStatus(conversationId);
        if (existing.value) {
            throw new Error(t('modules.conversation.errors.conversationExists', { conversationId }));
        }
        if (existing.errorCode && existing.errorCode !== 'not_found') {
            throw new Error(
                `Cannot create conversation ${conversationId}: history file is not readable (${existing.errorCode})`
            );
        }

        const now = Date.now();
        const meta: ConversationMetadata = {
            id: conversationId,
            title: title || t('modules.conversation.defaultTitle', { conversationId }),
            createdAt: now,
            updatedAt: now,
            workspaceUri,
            custom: {}
        };

        await this.storage.saveHistory(conversationId, []);
        await this.storage.saveMetadata(meta);
    }

    /**
     * 鍒犻櫎瀵硅瘽
     */
    async deleteConversation(conversationId: string): Promise<void> {
        await this.storage.deleteHistory(conversationId);
    }

    /**
     * 鍒楀嚭鎵€鏈夊璇?
     */
    async listConversations(): Promise<string[]> {
        return await this.storage.listConversations();
    }

    /**
     * 鍔犺浇瀵硅瘽鍘嗗彶锛堢洿鎺ヤ粠瀛樺偍璇诲彇锛?
     */
    private async loadHistory(conversationId: string): Promise<ConversationHistory> {
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        if (result.value) {
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            await this.createConversation(conversationId);
            return [];
        }
        throw new Error(
            `Failed to load conversation history (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }

    /**
     * 鑾峰彇瀵硅瘽鍘嗗彶鐨勫彧璇诲壇鏈?
     */
    async getHistory(conversationId: string): Promise<Readonly<ConversationHistory>> {
        const history = await this.loadHistory(conversationId);
        return JSON.parse(JSON.stringify(history));
    }

    /**
     * 鑾峰彇瀵硅瘽鍘嗗彶鐨勫紩鐢紙鐢ㄤ簬鐩存帴鍙戦€佺粰 API锛?
     * 娉ㄦ剰: 姣忔璋冪敤閮戒粠瀛樺偍璇诲彇鏈€鏂版暟鎹?
     */
    async getHistoryRef(conversationId: string): Promise<ConversationHistory> {
        return await this.loadHistory(conversationId);
    }

    // ==================== 娑堟伅鎿嶄綔 ====================

    /**
     * 娣诲姞娑堟伅锛圙emini 鏍煎紡锛?
     * 
     * @param conversationId 瀵硅瘽 ID
     * @param role 瑙掕壊
     * @param parts 娑堟伅鍐呭
     * @param metadata 鍙€夌殑鍏冩暟鎹紙濡?isUserInput锛?
     */
    async addMessage(
        conversationId: string,
        role: 'user' | 'model' | 'system',
        parts: ContentPart[],
        metadata?: Partial<Pick<Content, 'isUserInput' | 'isFunctionResponse' | 'isSummary'>>
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        history.push({
            role,
            parts: JSON.parse(JSON.stringify(parts)),
            timestamp: Date.now(),  // 鑷姩娣诲姞鏃堕棿鎴?
            ...metadata  // 鍚堝苟鍙€夊厓鏁版嵁
        });
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 娣诲姞瀹屾暣鐨?Content 瀵硅薄
     */
    async addContent(conversationId: string, content: Content): Promise<void> {
        const history = await this.loadHistory(conversationId);
        const contentCopy = JSON.parse(JSON.stringify(content));
        // 濡傛灉娌℃湁鏃堕棿鎴筹紝鑷姩娣诲姞
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }
        history.push(contentCopy);
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鎵归噺娣诲姞娑堟伅
     */
    async addBatch(conversationId: string, contents: Content[]): Promise<void> {
        const history = await this.loadHistory(conversationId);
        const now = Date.now();
        const contentsCopy = JSON.parse(JSON.stringify(contents)).map((content: Content, index: number) => {
            // 濡傛灉娌℃湁鏃堕棿鎴筹紝鑷姩娣诲姞锛堝悓涓€鎵规鐨勬秷鎭椂闂存埑閫掑锛?
            if (!content.timestamp) {
                content.timestamp = now + index;
            }
            return content;
        });
        history.push(...contentsCopy);
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鑾峰彇鎵€鏈夋秷鎭?
     *
     * 杩斿洖鐨勬瘡鏉℃秷鎭兘鍖呭惈 index 瀛楁锛岀敤浜庡墠绔湪鍒犻櫎/閲嶈瘯鏃剁洿鎺ヤ娇鐢?
     * 姣忔璋冪敤閮戒粠瀛樺偍璇诲彇鏈€鏂版暟鎹?
     * 
     * 娉ㄦ剰锛氬浜庢病鏈夊搷搴旂殑 pending 宸ュ叿璋冪敤锛屼細鑷姩鏍囪涓?rejected 骞舵坊鍔?functionResponse
     */
    async getMessages(conversationId: string): Promise<Content[]> {
        let history = await this.loadHistory(conversationId);
        history = await this.normalizeHistoryForDisplay(conversationId, history);

        // 涓烘瘡鏉℃秷鎭坊鍔?index 瀛楁锛堢粷瀵圭储寮曪級
        return history.map((message, index) => {
            // 杩囨护鍚庣鍐呴儴瀛楁锛坱urnDynamicContext 鏁版嵁閲忓ぇ涓斿墠绔棤闇€浣跨敤锛?
            const { turnDynamicContext, ...rest } = message;
            return {
                ...JSON.parse(JSON.stringify(rest)),
                index
            };
        });
    }

    /**
     * 鍒嗛〉鑾峰彇瀵硅瘽娑堟伅锛堜粎杩斿洖涓€涓獥鍙ｏ紝閬垮厤涓€娆℃€у悜 Webview 鍙戦€佸叏閲忓巻鍙诧級
     *
     * - beforeIndex: 鍙?[0, beforeIndex) 鍖洪棿鍐呯殑鏈€鍚?limit 鏉★紙鐢ㄤ簬涓婃媺鍔犺浇鏇存棭娑堟伅锛?
     * - offset/limit: 鍙?[offset, offset+limit) 鍖洪棿锛堢敤浜庝换鎰忓垎椤碉級
     *
     * 杩斿洖鐨?messages 涓瘡鏉￠兘鍖呭惈缁濆 index锛堝嵆鍚庣鍘嗗彶绱㈠紩锛夈€?
     */
    async getMessagesPaged(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<{ total: number; messages: Content[] }> {
        let history = await this.loadHistory(conversationId);
        history = await this.normalizeHistoryForDisplay(conversationId, history);

        const total = history.length;
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));

        let start = 0;
        let endExclusive = total;

        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            start = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            start = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(start, Math.min(total, start + limit));
        } else {
            // 榛樿锛氬彇鏈€鍚?limit 鏉?
            start = Math.max(0, total - limit);
            endExclusive = total;
        }

        const slice = history.slice(start, endExclusive);
        const messages = slice.map((message, i) => {
            const index = start + i;
            // 娣辨嫹璐濆苟杩囨护鍚庣鍐呴儴瀛楁锛坱urnDynamicContext 鏁版嵁閲忓ぇ涓斿墠绔棤闇€浣跨敤锛?
            const { turnDynamicContext, ...rest } = message;
            return {
                ...JSON.parse(JSON.stringify(rest)),
                index
            } as Content;
        });

        return { total, messages };
    }

    /**
     * 鑾峰彇鎸囧畾绱㈠紩鐨勬秷鎭?
     */
    async getMessage(conversationId: string, index: number): Promise<Content | undefined> {
        const history = await this.loadHistory(conversationId);
        if (index < 0 || index >= history.length) {
            return undefined;
        }
        return JSON.parse(JSON.stringify(history[index]));
    }

    /**
     * 鏇存柊娑堟伅
     */
    async updateMessage(
        conversationId: string,
        messageIndex: number,
        updates: Partial<Content>
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        if (messageIndex < 0 || messageIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
        }
        Object.assign(history[messageIndex], updates);
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鎵归噺鏇存柊澶氭潯娑堟伅锛堜竴娆¤鍐欙紝閬垮厤骞跺彂 updateMessage 瀵艰嚧鐨勮鐩栧啓鍏ワ級
     *
     * 鍏稿瀷鍦烘櫙锛歍oken 棰勮绠椾細骞惰鏇存柊澶氭潯 user 娑堟伅鐨?tokenCountByChannel銆?
     * 濡傛灉瀵规瘡鏉℃秷鎭崟鐙?load+save锛屽苟琛屾墽琛屼細鍑虹幇鈥滃悗鍐欒鐩栧厛鍐欌€濓紝瀵艰嚧澶ч噺 token 缁撴灉涓㈠け锛?
     * 杩涜€屽湪涓嬩竴娆¤姹傞噷鍙堥噸澶嶅鍚屼竴鎵规秷鎭繘琛?token 璁℃暟銆?
     */
    async updateMessagesBatch(
        conversationId: string,
        updates: Array<{ messageIndex: number; updates: Partial<Content> }>
    ): Promise<void> {
        if (updates.length === 0) {
            return;
        }

        const history = await this.loadHistory(conversationId);

        for (const item of updates) {
            const { messageIndex, updates: patch } = item;
            if (messageIndex < 0 || messageIndex >= history.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
            }
            Object.assign(history[messageIndex], patch);
        }

        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鍒犻櫎娑堟伅
     */
    async deleteMessage(conversationId: string, messageIndex: number): Promise<void> {
        const history = await this.loadHistory(conversationId);
        if (messageIndex < 0 || messageIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
        }
        history.splice(messageIndex, 1);
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鎻掑叆娑堟伅
     */
    async insertMessage(
        conversationId: string,
        position: number,
        role: 'user' | 'model' | 'system',
        parts: ContentPart[]
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        const index = Math.max(0, Math.min(position, history.length));
        history.splice(index, 0, {
            role,
            parts: JSON.parse(JSON.stringify(parts)),
            timestamp: Date.now()  // 鑷姩娣诲姞鏃堕棿鎴?
        });
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鍦ㄦ寚瀹氫綅缃彃鍏ュ畬鏁寸殑 Content 瀵硅薄
     */
    async insertContent(
        conversationId: string,
        position: number,
        content: Content
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        const index = Math.max(0, Math.min(position, history.length));
        const contentCopy = JSON.parse(JSON.stringify(content));
        // 濡傛灉娌℃湁鏃堕棿鎴筹紝鑷姩娣诲姞
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }
        history.splice(index, 0, contentCopy);
        await this.storage.saveHistory(conversationId, history);
    }

    // ==================== 鎵归噺鎿嶄綔 ====================

    /**
     * 鍒犻櫎鎸囧畾鑼冨洿鐨勬秷鎭?
     */
    async deleteMessagesInRange(
        conversationId: string,
        startIndex: number,
        endIndex: number
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        const start = Math.max(0, startIndex);
        const end = Math.min(history.length, endIndex + 1);
        history.splice(start, end - start);
        await this.storage.saveHistory(conversationId, history);
    }

    /**
     * 鍒犻櫎鍒版寚瀹氭秷鎭紙浠庡悗寰€鍓嶅垹闄わ級
     *
     * @param conversationId 瀵硅瘽 ID
     * @param targetIndex 鐩爣娑堟伅绱㈠紩锛堝垹闄ゅ埌杩欎釜绱㈠紩涓烘锛屽寘鎷娑堟伅锛?
     * @returns 鍒犻櫎鐨勬秷鎭暟閲?
     *
     * @example
     * // 鍒犻櫎鏈€鍚?3 鏉℃秷鎭紙鍋囪鍘嗗彶鏈?10 鏉★級
     * await manager.deleteToMessage('chat-001', 7); // 鍒犻櫎绱㈠紩 7, 8, 9
     *
     * 娉ㄦ剰锛氬垹闄ゅ悗鍙兘鐣欎笅瀛ょ珛鐨?functionCall锛堟病鏈夊搴旂殑 functionResponse锛?
     * ChatHandler 鍦ㄩ噸璇曟椂浼氭娴嬪苟閲嶆柊鎵ц杩欎簺瀛ょ珛鐨勫嚱鏁拌皟鐢?
     */
    async deleteToMessage(
        conversationId: string,
        targetIndex: number
    ): Promise<number> {
        const history = await this.loadHistory(conversationId);
        
        if (targetIndex < 0 || targetIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: targetIndex }));
        }
        
        // 浠庡悗寰€鍓嶅垹闄わ紝鐩村埌鍒犻櫎鍒扮洰鏍囩储寮曪紙鍖呮嫭鐩爣绱㈠紩锛?
        const deleteCount = history.length - targetIndex;
        history.splice(targetIndex, deleteCount);
        
        await this.storage.saveHistory(conversationId, history);
        return deleteCount;
    }

    /**
     * 娓呯┖瀵硅瘽鍘嗗彶
     */
    async clearHistory(conversationId: string): Promise<void> {
        await this.storage.saveHistory(conversationId, []);
    }

    // ==================== 鏌ヨ鍜岃繃婊?====================

    /**
     * 鏌ユ壘娑堟伅
     */
    async findMessages(
        conversationId: string,
        filter: MessageFilter
    ): Promise<MessagePosition[]> {
        const history = await this.loadHistory(conversationId);
        const results: MessagePosition[] = [];

        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            let matches = true;

            if (filter.role && message.role !== filter.role) {
                matches = false;
            }

            if (filter.hasFunctionCall !== undefined) {
                const hasFunctionCall = message.parts.some(p => p.functionCall !== undefined);
                if (hasFunctionCall !== filter.hasFunctionCall) {
                    matches = false;
                }
            }

            if (filter.hasText !== undefined) {
                const hasText = message.parts.some(
                    p => p.text !== undefined && p.text.trim() !== ''
                );
                if (hasText !== filter.hasText) {
                    matches = false;
                }
            }

            if (filter.isThought !== undefined) {
                const isThought = message.parts.some(p => p.thought === true);
                if (isThought !== filter.isThought) {
                    matches = false;
                }
            }

            if (filter.indexRange) {
                const { start, end } = filter.indexRange;
                if (i < start || i >= end) {
                    matches = false;
                }
            }

            if (matches) {
                results.push({ index: i, role: message.role });
            }
        }

        return results;
    }

    /**
     * 鑾峰彇鎸囧畾瑙掕壊鐨勬墍鏈夋秷鎭?
     */
    async getMessagesByRole(
        conversationId: string,
        role: 'user' | 'model' | 'system'
    ): Promise<Content[]> {
        const history = await this.loadHistory(conversationId);
        return history
            .filter(msg => msg.role === role)
            .map(msg => JSON.parse(JSON.stringify(msg)));
    }

    // ==================== 蹇収绠＄悊 ====================

    /**
     * 鍒涘缓蹇収
     */
    async createSnapshot(
        conversationId: string,
        name?: string,
        description?: string
    ): Promise<HistorySnapshot> {
        const history = await this.loadHistory(conversationId);
        const snapshot: HistorySnapshot = {
            id: `snapshot_${conversationId}_${Date.now()}`,
            conversationId,
            name,
            description,
            timestamp: Date.now(),
            history: JSON.parse(JSON.stringify(history))
        };
        await this.storage.saveSnapshot(snapshot);
        return snapshot;
    }

    /**
     * 鎭㈠蹇収
     */
    async restoreSnapshot(conversationId: string, snapshotId: string): Promise<void> {
        const snapshot = await this.storage.loadSnapshot(snapshotId);
        if (!snapshot) {
            throw new Error(t('modules.conversation.errors.snapshotNotFound', { snapshotId }));
        }
        if (snapshot.conversationId !== conversationId) {
            throw new Error(t('modules.conversation.errors.snapshotNotBelongToConversation'));
        }
        
        await this.storage.saveHistory(conversationId, snapshot.history);
    }

    /**
     * 鍒犻櫎蹇収
     */
    async deleteSnapshot(snapshotId: string): Promise<void> {
        await this.storage.deleteSnapshot(snapshotId);
    }

    /**
     * 鍒楀嚭瀵硅瘽鐨勬墍鏈夊揩鐓?
     */
    async listSnapshots(conversationId: string): Promise<string[]> {
        return await this.storage.listSnapshots(conversationId);
    }

    // ==================== 缁熻淇℃伅 ====================

    /**
     * 鑾峰彇缁熻淇℃伅
     */
    async getStats(conversationId: string): Promise<ConversationStats> {
        const history = await this.loadHistory(conversationId);
        
        let userMessages = 0;
        let modelMessages = 0;
        let functionCalls = 0;
        let hasThoughtSignatures = false;
        let hasThoughts = false;
        let hasFileData = false;
        let hasInlineData = false;
        let inlineDataSize = 0;
        const multimedia = {
            images: 0,
            audio: 0,
            video: 0,
            documents: 0
        };
        
        // Token 缁熻
        let totalThoughtsTokens = 0;
        let totalCandidatesTokens = 0;
        let messagesWithThoughtsTokens = 0;
        let messagesWithCandidatesTokens = 0;

        for (const message of history) {
            if (message.role === 'user') {
                userMessages++;
            } else {
                modelMessages++;
            }
            
            // 缁熻 token锛堜紭鍏堜娇鐢?usageMetadata锛屽悜鍚庡吋瀹规棫鏍煎紡锛?
            const thoughtsTokens = message.usageMetadata?.thoughtsTokenCount ?? message.thoughtsTokenCount;
            const candidatesTokens = message.usageMetadata?.candidatesTokenCount ?? message.candidatesTokenCount;
            
            if (thoughtsTokens !== undefined) {
                totalThoughtsTokens += thoughtsTokens;
                messagesWithThoughtsTokens++;
            }
            if (candidatesTokens !== undefined) {
                totalCandidatesTokens += candidatesTokens;
                messagesWithCandidatesTokens++;
            }

            for (const part of message.parts) {
                // 鍑芥暟璋冪敤
                if (part.functionCall) {
                    functionCalls++;
                }
                
                // 妫€鏌ユ€濊€冪鍚?
                if (part.thoughtSignatures) {
                    hasThoughtSignatures = true;
                }
                
                // 妫€鏌ユ€濊€冨唴瀹?
                if (part.thought === true) {
                    hasThoughts = true;
                }
                
                // 妫€鏌ユ枃浠舵暟鎹?
                if (part.fileData) {
                    hasFileData = true;
                }
                
                // 妫€鏌ュ唴宓屾暟鎹?
                if (part.inlineData) {
                    hasInlineData = true;
                    
                    // 璁＄畻 Base64 鏁版嵁澶у皬锛堢害涓哄師濮嬫暟鎹殑 4/3锛?
                    const base64Length = part.inlineData.data.length;
                    inlineDataSize += Math.ceil((base64Length * 3) / 4);
                    
                    // 缁熻澶氭ā鎬佺被鍨?
                    const mimeType = part.inlineData.mimeType;
                    if (mimeType.startsWith('image/')) {
                        multimedia.images++;
                    } else if (mimeType.startsWith('audio/')) {
                        multimedia.audio++;
                    } else if (mimeType.startsWith('video/')) {
                        multimedia.video++;
                    } else if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
                        multimedia.documents++;
                    }
                }
            }
        }

        return {
            totalMessages: history.length,
            userMessages,
            modelMessages,
            functionCalls,
            hasThoughtSignatures,
            hasThoughts,
            hasFileData,
            hasInlineData,
            inlineDataSize,
            multimedia,
            tokens: {
                totalThoughtsTokens,
                totalCandidatesTokens,
                totalTokens: totalThoughtsTokens + totalCandidatesTokens,
                messagesWithThoughtsTokens,
                messagesWithCandidatesTokens
            }
        };
    }

    /**
     * 鑾峰彇閫傚悎 API 璋冪敤鐨勫璇濆巻鍙?
     *
     * 姝ゆ柟娉曡繑鍥炴牸寮忓寲鐨勫巻鍙茶褰曪紝绉婚櫎鍐呴儴瀛楁锛堝 token 璁℃暟锛?
     *
     * 鎬濊€冨唴瀹硅繃婊ょ瓥鐣ワ細
     * - 榛樿鎯呭喌涓嬶紝鍙繚鐣欐渶鍚庝竴涓潪鍑芥暟鍝嶅簲 user 娑堟伅鍙婁箣鍚庣殑鎬濊€冨唴瀹瑰拰绛惧悕
     * - 濡傛灉鍚敤 sendHistoryThoughts锛屽垯淇濈暀鎵€鏈夊巻鍙叉€濊€冨唴瀹?
     * - 濡傛灉鍚敤 sendHistoryThoughtSignatures锛屽垯淇濈暀鎵€鏈夊巻鍙叉€濊€冪鍚嶏紙鎸夋笭閬撶被鍨嬭繃婊わ級
     *
     * @param conversationId 瀵硅瘽 ID
     * @param options 閫夐」瀵硅薄锛堝悜鍚庡吋瀹癸細濡傛灉浼犲叆 boolean锛岃涓?includeThoughts锛?
     * @returns 鏍煎紡鍖栫殑瀵硅瘽鍘嗗彶锛岀Щ闄や簡 token 璁℃暟瀛楁
     *
     * @example
     * // 涓嶅惈鎬濊€冿紙鐢ㄤ簬甯歌 API 璋冪敤锛?
     * const history = await manager.getHistoryForAPI('chat-001');
     *
     * // 鍚€濊€冿紙鐢ㄤ簬甯︽€濊€冪殑 API 璋冪敤锛屽 Gemini 3锛?
     * const historyWithThoughts = await manager.getHistoryForAPI('chat-001', { includeThoughts: true });
     *
     * // 鍙戦€佹墍鏈夊巻鍙叉€濊€冪鍚嶏紙Gemini 鏍煎紡锛?
     * const historyWithSignatures = await manager.getHistoryForAPI('chat-001', {
     *     includeThoughts: true,
     *     sendHistoryThoughtSignatures: true,
     *     channelType: 'gemini'
     * });
     */
    async getHistoryForAPI(
        conversationId: string,
        options: GetHistoryOptions | boolean = false
    ): Promise<ConversationHistory> {
        let history = await this.loadHistory(conversationId);
        
        // 鍚戝悗鍏煎锛氬鏋滀紶鍏?boolean锛岃涓?includeThoughts
        const opts: GetHistoryOptions = typeof options === 'boolean'
            ? { includeThoughts: options }
            : options;
        
        // 搴旂敤璧峰绱㈠紩锛堢敤浜庝笂涓嬫枃瑁佸壀锛?
        const startIndex = opts.startIndex ?? 0;
        if (startIndex > 0 && startIndex < history.length) {
            history = history.slice(startIndex);
        }
        
        const includeThoughts = opts.includeThoughts ?? false;
        const sendHistoryThoughts = opts.sendHistoryThoughts ?? false;
        const sendHistoryThoughtSignatures = opts.sendHistoryThoughtSignatures ?? false;
        // 褰撳墠杞閰嶇疆锛氬鏋滄病鏈変紶锛孉nthropic 榛樿鍏ㄤ紶锛孏emini/OpenAI 榛樿涓嶄紶鏂囨湰鍐呭
        const sendCurrentThoughts = opts.sendCurrentThoughts ?? (opts.channelType === 'anthropic' || opts.channelType === 'openai-responses');
        const sendCurrentThoughtSignatures = opts.sendCurrentThoughtSignatures ?? (opts.channelType === 'gemini' || opts.channelType === 'openai-responses');
        const channelType = opts.channelType;
        // 鍘嗗彶鎬濊€冨洖鍚堟暟锛岄粯璁?-1 琛ㄧず鍏ㄩ儴
        const historyThinkingRounds = opts.historyThinkingRounds ?? -1;
        
        // 鎵惧埌鏈€鍚庝竴涓潪鍑芥暟鍝嶅簲鐨?user 娑堟伅鐨勭储寮?
        let lastNonFunctionResponseUserIndex = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (message.role === 'user' && !message.isFunctionResponse) {
                lastNonFunctionResponseUserIndex = i;
                break;
            }
        }
        
        // 璇嗗埆鎵€鏈夊洖鍚堝苟璁＄畻鍝簺鍥炲悎闇€瑕佸彂閫佸巻鍙叉€濊€?
        // 鍥炲悎瀹氫箟锛氫粠涓€涓潪鍑芥暟鍝嶅簲鐨?user 娑堟伅寮€濮嬶紝鍒颁笅涓€涓潪鍑芥暟鍝嶅簲鐨?user 娑堟伅涔嬪墠缁撴潫
        const roundStartIndices: number[] = [];
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.role === 'user' && !message.isFunctionResponse) {
                roundStartIndices.push(i);
            }
        }
        
        // 璁＄畻闇€瑕佸彂閫佸巻鍙叉€濊€冪殑娑堟伅绱㈠紩鑼冨洿
        // historyThinkingRounds 鎺у埗鍙戦€佸灏戣疆闈炴渶鏂板洖鍚堢殑鎬濊€?
        let historyThoughtMinIndex = 0;  // 鏈€灏忕储寮曪紙鍖呭惈锛?
        let historyThoughtMaxIndex = lastNonFunctionResponseUserIndex;  // 鏈€澶х储寮曪紙涓嶅寘鍚紝鍥犱负鏈€鏂板洖鍚堢敱 sendCurrentThoughts 鎺у埗锛?
        
        if (historyThinkingRounds === 0) {
            // 0 琛ㄧず涓嶅彂閫佷换浣曞巻鍙插洖鍚堢殑鎬濊€?
            // 璁剧疆 min > max 浣胯寖鍥存棤鏁?
            historyThoughtMinIndex = history.length;
            historyThoughtMaxIndex = -1;
        } else if (historyThinkingRounds > 0) {
            // 姝ｆ暟 n 琛ㄧず鍙戦€佹渶杩?n 杞潪鏈€鏂板洖鍚堢殑鎬濊€?
            // 渚嬪 historyThinkingRounds=1锛屾€诲叡鏈?5 涓洖鍚堬紙绱㈠紩 0-4锛夛紝鏈€鏂板洖鍚堟槸 4
            // 閭ｄ箞鍙彂閫佸洖鍚?3锛堝€掓暟绗簩鍥炲悎锛夌殑鎬濊€?
            const totalRounds = roundStartIndices.length;
            
            if (totalRounds > 1) {
                // 闇€瑕佽烦杩囩殑鍥炲悎鏁?= 鎬诲洖鍚堟暟 - 1锛堟渶鏂板洖鍚堬級 - historyThinkingRounds
                const roundsToSkip = Math.max(0, totalRounds - 1 - historyThinkingRounds);
                
                if (roundsToSkip > 0 && roundsToSkip < totalRounds) {
                    // 浠?roundsToSkip 鍥炲悎寮€濮嬪彂閫?
                    historyThoughtMinIndex = roundStartIndices[roundsToSkip];
                }
            }
        }
        // historyThinkingRounds === -1 鏃朵繚鎸侀粯璁ゅ€硷紝鍙戦€佹墍鏈夊巻鍙插洖鍚堢殑鎬濊€?
        
        /**
         * 澶勭悊鍗曚釜 part 鐨勬€濊€冪鍚?
         * 鏍规嵁閰嶇疆鍐冲畾鏄惁淇濈暀绛惧悕锛屽苟鎸夋笭閬撶被鍨嬭繃婊?
         *
         * 娉ㄦ剰锛氭€濊€冪鍚嶅彂閫佷笉渚濊禆浜?includeThoughts锛堟笭閬撴槸鍚︽敮鎸佹€濊€冿級
         * 杩欐槸鍥犱负鍘嗗彶涓殑绛惧悕鍙兘鏉ヨ嚜浠讳綍娓犻亾锛堝 Gemini锛夛紝鑰屽綋鍓嶄娇鐢ㄥ叾浠栨笭閬撶户缁璇?
         * 鐢ㄦ埛鍙兘甯屾湜灏?Gemini 浜х敓鐨勭鍚嶅彂閫佺粰鍏朵粬娓犻亾
         *
         * @param part 瑕佸鐞嗙殑 part
         * @param isHistoryPart 鏄惁鏄巻鍙叉秷鎭腑鐨?part
         * @param messageIndex 娑堟伅鍦ㄥ巻鍙蹭腑鐨勭储寮?
         */
        const processThoughtSignatures = (
            part: ContentPart,
            isHistoryPart: boolean,
            messageIndex: number
        ): ContentPart => {
            // 1. 澶勭悊鍘嗗彶娑堟伅鐨勭鍚?
            if (isHistoryPart) {
                if (!sendHistoryThoughtSignatures) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
                // 妫€鏌ユ槸鍚﹀湪鍏佽鐨勫巻鍙叉€濊€冨洖鍚堣寖鍥村唴
                const isInHistoryThoughtRange = messageIndex >= historyThoughtMinIndex && messageIndex < historyThoughtMaxIndex;
                if (!isInHistoryThoughtRange) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
            } else {
                // 2. 澶勭悊褰撳墠杞鐨勭鍚?
                // 褰撳墠杞鐨勭鍚嶅彂閫佺敱 sendCurrentThoughtSignatures 鐙珛鎺у埗
                if (!sendCurrentThoughtSignatures) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
            }

            if (!part.thoughtSignatures) {
                return part;
            }
            
            // 3. 濡傛灉鎸囧畾浜嗘笭閬撶被鍨嬶紝鍙繚鐣欏搴旀牸寮忕殑绛惧悕
            if (channelType && part.thoughtSignatures[channelType]) {
                return {
                    ...part,
                    thoughtSignatures: {
                        [channelType]: part.thoughtSignatures[channelType]
                    }
                };
            }
            
            // 濡傛灉娌℃湁鎸囧畾娓犻亾绫诲瀷鎴栨病鏈夊搴旀牸寮忕殑绛惧悕锛屼繚鐣欏師鏍?
            return part;
        };
        
        /**
         * 鏀寔鐨勫浘鐗?MIME 绫诲瀷
         */
        const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
        
        /**
         * 鏀寔鐨勬枃妗?MIME 绫诲瀷
         */
        const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain'];
        
        /**
         * 娓呯悊 inlineData 涓殑鍏冩暟鎹瓧娈?
         *
         * 鏍规嵁娓犻亾绫诲瀷鍐冲畾淇濈暀鍝簺瀛楁锛?
         * - Gemini: 淇濈暀 mimeType, data, displayName锛圙emini API 鏀寔 displayName锛?
         * - OpenAI/Anthropic: 鍙繚鐣?mimeType, data锛堜笉鏀寔 displayName锛?
         *
         * id 鍜?name 瀛楁浠呯敤浜庡瓨鍌ㄥ拰鍓嶇鏄剧ず锛屽缁堜笉鍙戦€佺粰 AI
         *
         * 澶氭ā鎬佽兘鍔涜繃婊ょ瓥鐣ワ細
         * - 鐢ㄦ埛涓诲姩鎻愪氦鐨勯檮浠朵笉鍙楀妯℃€佸伐鍏烽厤缃奖鍝?
         * - 瀵逛簬宸ュ叿鍝嶅簲娑堟伅锛?
         *   - 濡傛灉娓犻亾涓嶆敮鎸佸妯℃€侊紙濡?OpenAI function_call锛夛紝濮嬬粓杩囨护
         *   - 濡傛灉娓犻亾鏀寔浣嗕笉鏀寔鍘嗗彶澶氭ā鎬侊紝鍙繃婊ゅ巻鍙蹭腑鐨勫妯℃€佹暟鎹?
         *   - 鍚﹀垯淇濈暀澶氭ā鎬佹暟鎹?
         *
         * @param part 瑕佸鐞嗙殑 ContentPart
         * @param isFunctionResponse 鏄惁鏄伐鍏峰搷搴旀秷鎭?
         * @param isHistoryMessage 鏄惁鏄巻鍙叉秷鎭紙褰撳墠杞涔嬪墠鐨勬秷鎭級
         */
        const cleanInlineData = (part: ContentPart, isFunctionResponse: boolean, isHistoryMessage: boolean): ContentPart | null => {
            if (!part.inlineData) {
                return part;
            }
            
            // 鑾峰彇澶氭ā鎬佽兘鍔涢厤缃?
            const capability = opts.multimodalCapability;
            
            // 澶氭ā鎬佽兘鍔涜繃婊ょ瓥鐣ワ紙浠呭宸ュ叿鍝嶅簲娑堟伅鐢熸晥锛夛細
            // 鐢ㄦ埛涓诲姩鎻愪氦鐨勯檮浠朵笉鍙楀妯℃€佸伐鍏烽厤缃奖鍝?
            if (capability && isFunctionResponse) {
                const mimeType = part.inlineData.mimeType;
                
                // 棣栧厛妫€鏌ユ笭閬撴槸鍚︽敮鎸佹绫诲瀷鐨勫妯℃€?
                // 濡傛灉涓嶆敮鎸侊紝鍗充娇鏄綋鍓嶈疆娆′篃瑕佽繃婊わ紙濡?OpenAI function_call 妯″紡锛?
                const isImage = IMAGE_MIME_TYPES.includes(mimeType);
                const isDocument = DOCUMENT_MIME_TYPES.includes(mimeType);
                
                if (isImage && !capability.supportsImages) {
                    // 娓犻亾涓嶆敮鎸佸浘鐗囷紙濡?OpenAI function_call锛夛紝濮嬬粓杩囨护
                    return null;
                }
                
                if (isDocument && !capability.supportsDocuments) {
                    // 娓犻亾涓嶆敮鎸佹枃妗ｏ紝濮嬬粓杩囨护
                    return null;
                }
                
                // 娓犻亾鏀寔姝ょ被鍨嬶紝浣嗛渶瑕佹鏌ユ槸鍚︽敮鎸佸巻鍙插妯℃€?
                // 濡傛灉鏄巻鍙叉秷鎭笖涓嶆敮鎸佸巻鍙插妯℃€侊紝鍒欒繃婊?
                if (isHistoryMessage && !capability.supportsHistoryMultimodal) {
                    return null;
                }
            }
            
            // 鏍规嵁娓犻亾绫诲瀷鍐冲畾鏄惁淇濈暀 displayName
            // Gemini 鏀寔 displayName锛孫penAI/Anthropic 涓嶆敮鎸?
            if (channelType === 'gemini') {
                // Gemini: 淇濈暀 displayName锛岀Щ闄?id 鍜?name
                const { id, name, ...cleanedInlineData } = part.inlineData;
                return {
                    ...part,
                    inlineData: cleanedInlineData
                };
            } else {
                // OpenAI/Anthropic/Custom: 绉婚櫎 id, name, displayName
                const { id, name, displayName, ...cleanedInlineData } = part.inlineData;
                return {
                    ...part,
                    inlineData: cleanedInlineData
                };
            }
        };
        
        // 棣栧厛鏀堕泦鎵€鏈夎鎷掔粷鐨勫伐鍏疯皟鐢?ID
        const rejectedToolCallIds = new Set<string>();
        for (const message of history) {
            for (const part of message.parts) {
                if (part.functionCall?.rejected && part.functionCall.id) {
                    rejectedToolCallIds.add(part.functionCall.id);
                }
            }
        }
        
        /**
         * 娓呯悊 functionCall 涓殑鍐呴儴瀛楁
         *
         * rejected 瀛楁鏄唴閮ㄤ娇鐢ㄧ殑锛岀敤浜庢爣璁扮敤鎴锋嫆缁濇墽琛岀殑宸ュ叿
         * 涓嶅簲璇ュ彂閫佺粰 AI API锛屽洜涓?API 涓嶈瘑鍒瀛楁
         */
        const cleanFunctionCall = (part: ContentPart): ContentPart => {
            if (!part.functionCall) {
                return part;
            }
            
            // 绉婚櫎 rejected 瀛楁
            const { rejected, ...cleanedFunctionCall } = part.functionCall;
            return {
                ...part,
                functionCall: cleanedFunctionCall
            };
        };
        
        /**
         * 澶勭悊 functionResponse
         *
         * 濡傛灉瀵瑰簲鐨?functionCall 琚爣璁颁负 rejected锛?
         * 闇€瑕佸皢 response 淇敼涓鸿〃绀鸿鎷掔粷鐨勭姸鎬侊紝
         * 杩欐牱 AI 鎵嶈兘鐭ラ亾宸ュ叿娌℃湁琚墽琛?
         *
         * 鍚屾椂娓呯悊涓嶅簲鍙戦€佺粰 AI 鐨勫唴閮ㄥ瓧娈碉紙濡?diffContentId锛?
         */
        const processFunctionResponse = (part: ContentPart): ContentPart => {
            if (!part.functionResponse) {
                return part;
            }
            
            // 妫€鏌ュ搴旂殑 functionCall 鏄惁琚嫆缁?
            if (part.functionResponse.id && rejectedToolCallIds.has(part.functionResponse.id)) {
                // 淇敼 response 涓鸿〃绀鸿鎷掔粷鐨勭姸鎬?
                return {
                    ...part,
                    functionResponse: {
                        ...part.functionResponse,
                        response: {
                            success: false,
                            error: t('modules.api.chat.errors.userRejectedTool'),
                            rejected: true
                        }
                    }
                };
            }
            
            // 娓呯悊涓嶅簲鍙戦€佺粰 AI 鐨勫唴閮ㄥ瓧娈碉紙浣跨敤鍏变韩鍑芥暟纭繚涓€鑷存€э級
            const cleanedResponse = cleanFunctionResponseForAPI(
                part.functionResponse.response as Record<string, unknown>
            );
            
            return {
                ...part,
                functionResponse: {
                    ...part.functionResponse,
                    response: cleanedResponse
                }
            };
        };
        
        /**
         * 澶勭悊鍗曟潯娑堟伅
         */
        const processMessage = (message: Content, index: number): Content | null => {
            const isHistoryMessage = index < lastNonFunctionResponseUserIndex;
            // 妫€鏌ユ秷鎭槸鍚︽槸宸ュ叿鍝嶅簲锛堢敤浜庡喅瀹氭槸鍚﹀簲鐢ㄥ妯℃€佽兘鍔涜繃婊わ級
            const isFunctionResponse = !!message.isFunctionResponse;
            
            let parts = message.parts;
            
            // 澶勭悊鎬濊€冨唴瀹?(Thought Text/Reasoning Content)
            // 娉ㄦ剰锛氭€濊€冨彂閫佷笉渚濊禆浜?includeThoughts锛堟笭閬撴槸鍚︽敮鎸佹€濊€冿級
            // 杩欐槸鍥犱负鍘嗗彶涓殑鎬濊€冨唴瀹瑰彲鑳芥潵鑷换浣曟笭閬擄紙濡?Gemini锛夛紝鑰屽綋鍓嶄娇鐢ㄥ叾浠栨笭閬撶户缁璇?
            // 鐢ㄦ埛鍙兘甯屾湜灏?Gemini 浜х敓鐨勬€濊€冨唴瀹瑰彂閫佺粰 OpenAI/Anthropic 娓犻亾
            if (isHistoryMessage) {
                // 鍘嗗彶娑堟伅锛氭牴鎹?sendHistoryThoughts 閰嶇疆鍜?historyThinkingRounds 鍐冲畾
                if (!sendHistoryThoughts) {
                    // 浠呰繃婊ゆ帀绾€濊€冨唴瀹癸紝淇濈暀鍖呭惈绛惧悕鐨?Part
                    parts = parts.filter(part => !part.thought || part.thoughtSignatures);
                } else {
                    // 妫€鏌ュ綋鍓嶆秷鎭槸鍚﹀湪鍏佽鐨勫巻鍙叉€濊€冨洖鍚堣寖鍥村唴
                    const isInHistoryThoughtRange = index >= historyThoughtMinIndex && index < historyThoughtMaxIndex;
                    if (!isInHistoryThoughtRange) {
                        parts = parts.filter(part => !part.thought);
                    }
                }
            } else {
                // 褰撳墠杞 (Latest Round)
                // 褰撳墠杞鐨勬€濊€冨彂閫佺敱 sendCurrentThoughts 鐙珛鎺у埗
                if (!sendCurrentThoughts) {
                    // 浠呰繃婊ゆ帀绾€濊€冨唴瀹癸紝淇濈暀鍖呭惈绛惧悕鐨?Part
                    parts = parts.filter(part => !part.thought || part.thoughtSignatures);
                }
            }
            
            // 澶勭悊鎬濊€冪鍚嶃€佹竻鐞?inlineData 鍏冩暟鎹€佹竻鐞?functionCall 鍐呴儴瀛楁銆佸鐞嗚鎷掔粷鐨勫伐鍏峰搷搴?
            // 娉ㄦ剰锛氬彧鏈夊巻鍙蹭腑鐨勫伐鍏峰搷搴旀秷鎭墠浼氬簲鐢?supportsHistoryMultimodal 杩囨护
            // 褰撳墠杞鐨勫伐鍏峰搷搴斿缁堜繚鐣欏妯℃€佹暟鎹?
            parts = parts
                .map(part => processThoughtSignatures(part, isHistoryMessage, index))
                .map(part => cleanInlineData(part, isFunctionResponse, isHistoryMessage))
                .map(part => part ? cleanFunctionCall(part) : part)
                .map(part => part ? processFunctionResponse(part) : part)
                // 杩囨护绌?part锛?
                // - null锛堣 cleanInlineData 绛夎繃婊わ級
                // - 绌哄璞?
                // - 浠呭寘鍚?thought: true 鐨勨€滅┖ thought 鍧椻€濓紙甯歌浜庯細鍘熸湰鍙湁 thoughtSignatures锛屽悗缁張琚厤缃繃婊ゆ帀绛惧悕锛?
                //   杩欑被 part 鍦ㄤ笉鍚屾ā鍨?娓犻亾涓嬪彲鑳藉鑷村吋瀹规€ч棶棰樸€?
                .filter((part): part is ContentPart => {
                    if (part === null) return false;
                    const keys = Object.keys(part);
                    if (keys.length === 0) return false;
                    if (keys.length === 1 && keys[0] === 'thought' && (part as any).thought === true) return false;
                    return true;
                });
            
            if (parts.length === 0) {
                return null;
            }
            
            // 淇濈暀蹇呰鐨勫厓鏁版嵁瀛楁
            const result: Content = {
                role: message.role,
                parts
            };
            
            // 淇濈暀 isUserInput 鏍囪锛堢敤浜庣‘瀹氬姩鎬佹彁绀鸿瘝鎻掑叆浣嶇疆锛?
            if (message.isUserInput) {
                result.isUserInput = true;
            }
            
            return result;
        };
        
        // 澶勭悊鎵€鏈夋秷鎭?
        return history
            .map((message, index) => processMessage(message, index))
            .filter((message): message is Content => message !== null);
    }

    // ==================== 鍏冩暟鎹鐞?====================

    /**
     * 璁剧疆瀵硅瘽鏍囬
     */
    async setTitle(conversationId: string, title: string): Promise<void> {
        let meta = await this.loadMetadataForWrite(conversationId);
        if (!meta) {
            meta = {
                id: conversationId,
                title,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                custom: {}
            };
        } else {
            meta.title = title;
            meta.updatedAt = Date.now();
        }
        await this.storage.saveMetadata(meta);
    }

    /**
     * 璁剧疆宸ヤ綔鍖?URI
     */
    async setWorkspaceUri(conversationId: string, workspaceUri: string): Promise<void> {
        let meta = await this.loadMetadataForWrite(conversationId);
        if (!meta) {
            meta = {
                id: conversationId,
                title: t('modules.conversation.defaultTitle', { conversationId }),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                workspaceUri,
                custom: {}
            };
        } else {
            meta.workspaceUri = workspaceUri;
            meta.updatedAt = Date.now();
        }
        await this.storage.saveMetadata(meta);
    }

    /**
     * 鑾峰彇瀵硅瘽鍏冩暟鎹?
     */
    async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const [metadataResult, historyResult, integrity] = await Promise.all([
            this.storage.loadMetadataWithStatus(conversationId),
            this.storage.loadHistoryWithStatus(conversationId),
            this.storage.getConversationIntegrity(conversationId),
        ]);

        const integrityStatus = this.resolveIntegrityStatus(integrity);

        if (metadataResult.value) {
            const metadata = JSON.parse(JSON.stringify(metadataResult.value)) as ConversationMetadata;
            if (integrityStatus) {
                metadata.integrityStatus = integrityStatus;
            }
            return metadata;
        }

        if (historyResult.errorCode === 'not_found' && !historyResult.value) {
            return null;
        }

        const fallback = this.createFallbackMetadata(conversationId, historyResult.value);
        if (integrityStatus) {
            fallback.integrityStatus = integrityStatus;
        }
        return fallback;
    }

    /**
     * 璁剧疆鑷畾涔夊厓鏁版嵁
     */
    async setCustomMetadata(
        conversationId: string,
        key: string,
        value: unknown
    ): Promise<void> {
        let meta = await this.loadMetadataForWrite(conversationId);
        if (!meta) {
            meta = {
                id: conversationId,
                title: t('modules.conversation.defaultTitle', { conversationId }),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                custom: {}
            };
        }
        
        if (!meta.custom) {
            meta.custom = {};
        }
        meta.custom[key] = value;
        meta.updatedAt = Date.now();
        
        await this.storage.saveMetadata(meta);
    }

    /**
     * 鑾峰彇鑷畾涔夊厓鏁版嵁
     */
    async getCustomMetadata(conversationId: string, key: string): Promise<unknown> {
        const meta = await this.getMetadata(conversationId);
        return meta?.custom?.[key];
    }

    // ==================== 宸ュ叿璋冪敤绠＄悊 ====================

    /**
     * 鏍囪鎸囧畾娑堟伅涓殑宸ュ叿璋冪敤涓烘嫆缁濈姸鎬?
     *
     * 褰撶敤鎴峰湪绛夊緟宸ュ叿纭鏃剁偣鍑荤粓姝㈡寜閽紝闇€瑕佸皢绛夊緟涓殑宸ュ叿鏍囪涓烘嫆缁?
     * 鍚屾椂娣诲姞瀵瑰簲鐨?functionResponse锛岃繖鏍?API 鎵嶄笉浼氭姤閿?
     *
     * @param conversationId 瀵硅瘽 ID
     * @param messageIndex 娑堟伅绱㈠紩
     * @param toolCallIds 瑕佹爣璁颁负鎷掔粷鐨勫伐鍏疯皟鐢?ID 鍒楄〃锛堝鏋滀负绌猴紝鍒欐爣璁版墍鏈夋湭鎵ц鐨勫伐鍏凤級
     */
    async rejectToolCalls(
        conversationId: string,
        messageIndex: number,
        toolCallIds?: string[]
    ): Promise<void> {
        const history = await this.loadHistory(conversationId);
        
        if (messageIndex < 0 || messageIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
        }
        
        const message = history[messageIndex];
        let modified = false;
        
        // 鏀堕泦鎵€鏈夊凡鏈夊搷搴旂殑宸ュ叿 ID
        const respondedToolIds = new Set<string>();
        for (let i = messageIndex + 1; i < history.length; i++) {
            const msg = history[i];
            for (const part of msg.parts) {
                if (part.functionResponse?.id) {
                    respondedToolIds.add(part.functionResponse.id);
                }
            }
        }
        
        // 鏀堕泦闇€瑕佹嫆缁濈殑宸ュ叿璋冪敤
        const rejectedCalls: Array<{ id: string; name: string }> = [];
        
        // 鏍囪宸ュ叿涓烘嫆缁濈姸鎬?
        for (const part of message.parts) {
            if (part.functionCall && part.functionCall.id) {
                // 妫€鏌ユ槸鍚﹂渶瑕佹爣璁版宸ュ叿
                const shouldReject = toolCallIds
                    ? toolCallIds.includes(part.functionCall.id)
                    : !respondedToolIds.has(part.functionCall.id);
                
                if (shouldReject && !part.functionCall.rejected) {
                    part.functionCall.rejected = true;
                    modified = true;
                    
                    // 鏀堕泦琚嫆缁濈殑宸ュ叿淇℃伅
                    rejectedCalls.push({
                        id: part.functionCall.id,
                        name: part.functionCall.name || 'unknown'
                    });
                }
            }
        }
        
        // 涓鸿鎷掔粷鐨勫伐鍏锋坊鍔?functionResponse
        if (rejectedCalls.length > 0) {
            const rejectedResponseParts: ContentPart[] = rejectedCalls.map(call => ({
                functionResponse: {
                    name: call.name,
                    id: call.id,
                    response: {
                        success: false,
                        error: t('modules.api.chat.errors.userRejectedTool'),
                        rejected: true
                    }
                }
            }));
            
            // 鍦ㄥ伐鍏疯皟鐢ㄦ秷鎭殑绱ф帴鍚庨潰鎻掑叆 functionResponse
            history.splice(messageIndex + 1, 0, {
                role: 'user',
                parts: rejectedResponseParts,
                isFunctionResponse: true
            });
            modified = true;
        }
        
        if (modified) {
            await this.storage.saveHistory(conversationId, history);
        }
    }
    
    /**
     * 鎷掔粷鎵€鏈夋湭鍝嶅簲鐨勫伐鍏疯皟鐢?
     * 
     * 鐢ㄤ簬鐢ㄦ埛涓柇鎿嶄綔锛堝垹闄ゆ秷鎭€佸垏鎹㈠璇濈瓑锛夋椂锛屽皢鎵€鏈?pending 鐨勫伐鍏疯皟鐢ㄦ爣璁颁负 rejected
     * 骞跺湪宸ュ叿璋冪敤娑堟伅绱ф帴鍚庨潰鎻掑叆 functionResponse
     * 
     * @param conversationId 瀵硅瘽 ID
     */
    async rejectAllPendingToolCalls(conversationId: string): Promise<void> {
        const history = await this.loadHistory(conversationId);
        if (history.length === 0) return;
        
        // 鏀堕泦鎵€鏈?functionResponse 鐨?ID
        const respondedToolCallIds = new Set<string>();
        for (const message of history) {
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.functionResponse?.id) {
                        respondedToolCallIds.add(part.functionResponse.id);
                    }
                }
            }
        }
        
        // 鏀堕泦鏈搷搴旂殑宸ュ叿璋冪敤锛岃褰曞畠浠墍鍦ㄧ殑娑堟伅绱㈠紩
        const unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string }>> = new Map();
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.functionCall && part.functionCall.id) {
                        // 濡傛灉宸ュ叿璋冪敤娌℃湁瀵瑰簲鐨勫搷搴旓紝涓旇繕娌℃湁琚爣璁颁负 rejected
                        if (!respondedToolCallIds.has(part.functionCall.id) && !part.functionCall.rejected) {
                            part.functionCall.rejected = true;
                            const calls = unresolvedCallsByIndex.get(i) || [];
                            calls.push({
                                id: part.functionCall.id,
                                name: part.functionCall.name || 'unknown'
                            });
                            unresolvedCallsByIndex.set(i, calls);
                        }
                    }
                }
            }
        }
        
        // 濡傛灉鏈夋湭鍝嶅簲鐨勫伐鍏疯皟鐢紝鍦ㄥ伐鍏疯皟鐢ㄦ秷鎭揣鎺ュ悗闈㈡彃鍏?functionResponse
        // 浠庡悗寰€鍓嶆彃鍏ヤ互閬垮厤绱㈠紩鍋忕Щ闂
        if (unresolvedCallsByIndex.size > 0) {
            const sortedIndices = Array.from(unresolvedCallsByIndex.keys()).sort((a, b) => b - a);
            
            for (const messageIndex of sortedIndices) {
                const calls = unresolvedCallsByIndex.get(messageIndex)!;
                const rejectedResponseParts: ContentPart[] = calls.map(call => ({
                    functionResponse: {
                        name: call.name,
                        id: call.id,
                        response: {
                            success: false,
                            error: t('modules.api.chat.errors.userRejectedTool'),
                            rejected: true
                        }
                    }
                }));
                
                // 鍦ㄥ伐鍏疯皟鐢ㄦ秷鎭殑绱ф帴鍚庨潰鎻掑叆
                history.splice(messageIndex + 1, 0, {
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                });
            }
            
            await this.storage.saveHistory(conversationId, history);
        }
    }
}

