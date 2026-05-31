/**
 * LimCode - 娴佸紡鍝嶅簲绱姞鍣?
 *
 * 鐢ㄤ簬绱姞娴佸紡鍝嶅簲鍧楋紝鐢熸垚瀹屾暣鐨?Content
 * 鍙傝€?Gemini 娴佸紡鍝嶅簲鏍煎紡璁捐
 */

import type { Content, ContentPart, UsageMetadata, ThoughtSignatures } from '../conversation/types';
import type { StreamChunk, StreamUsageMetadata } from './types';
import type { ToolMode } from '../config/configs/base';
import { parseXMLToolCalls } from '../../tools/xmlFormatter';
import { IncrementalPromptToolParser } from '../../tools/promptToolParser';

// JSON 宸ュ叿璋冪敤杈圭晫鏍囪
const TOOL_CALL_START = '<<<TOOL_CALL>>>';
const TOOL_CALL_END = '<<<END_TOOL_CALL>>>';

// XML 宸ュ叿璋冪敤鏍囪
const XML_TOOL_START = '<tool_use>';
const XML_TOOL_END = '</tool_use>';

interface BuildContentOptions {
    parsePartialArgs: boolean;
    includeInternalFunctionCallFields: boolean;
    warnOnParseFailure: boolean;
    finalizeFunctionCallIndex?: number;
}

export interface StreamingContentOptions {
    includeInternalFields?: boolean;
}

/**
 * 娴佸紡绱姞鍣?
 *
 * 璐熻矗鎺ユ敹鍜岀疮鍔犳祦寮忓搷搴斿潡锛屾渶缁堢敓鎴愬畬鏁寸殑 Content
 *
 * 璁捐鍘熷垯锛?
 * - 鍙傝€?Gemini 娴佸紡鍝嶅簲鏍煎紡
 * - 鏀寔鎬濊€冨唴瀹癸紙thought: true锛夊拰鏅€氬唴瀹圭殑鍒嗙
 * - 鑷姩鍚堝苟鐩稿悓绫诲瀷鐨勮繛缁?parts
 * - 姝ｇ‘澶勭悊 token 缁熻淇℃伅
 * - 鏀寔澶氭牸寮忔€濊€冪鍚嶅瓨鍌?
 */
export class StreamAccumulator {
    /** 绱姞鐨?parts */
    private parts: ContentPart[] = [];

    /**
     * 宸查€氳繃 getNewCompletedFunctionCalls() 杩斿洖杩囩殑 functionCall 绱㈠紩闆嗗悎銆?
     * 鐢ㄤ簬娴佸紡杈规墽琛屽伐鍏凤細鍙繑鍥炶嚜涓婃璋冪敤浠ユ潵鏂板畬鎴愶紙args 瑙ｆ瀽鎴愬姛锛夌殑 functionCall銆?
     */
    private reportedFunctionCallIndices = new Set<number>();


    /** 鏄惁瀹屾垚 */
    private isDone: boolean = false;

    /** 瀹屾暣鐨?Token 浣跨敤缁熻 */
    private usageMetadata?: UsageMetadata;

    /** 鏄惁鏀跺埌杩囨笭閬撳師鐢熺殑 totalTokenCount */
    private hasProviderTotalTokenCount: boolean = false;

    /** 缁撴潫鍘熷洜 */
    private finishReason?: string;

    /** 妯″瀷鐗堟湰 */
    private modelVersion?: string;

    /** 澶氭牸寮忔€濊€冪鍚?*/
    private thoughtSignatures: ThoughtSignatures = {};

    /** API 鎻愪緵鍟嗙被鍨嬶紙鐢ㄤ簬纭畾绛惧悕鏍煎紡锛?*/
    private providerType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' = 'gemini';

    /** 鎬濊€冨紑濮嬫椂闂存埑锛堟绉掞級 */
    private thinkingStartTime?: number;

    /** 鎬濊€冩寔缁椂闂达紙姣锛?*/
    private thinkingDuration?: number;

    /** 鏄惁宸茬粡鏀跺埌闈炴€濊€冪殑鏅€氭枃鏈?*/
    private hasReceivedNormalText: boolean = false;

    /** 娴佸紡鍧楄鏁?*/
    private chunkCount: number = 0;

    /** 绗竴涓祦寮忓潡鏃堕棿鎴筹紙姣锛?*/
    private firstChunkTime?: number;

    /** 鏈€鍚庝竴涓祦寮忓潡鏃堕棿鎴筹紙姣锛?*/
    private lastChunkTime?: number;

    /** 璇锋眰寮€濮嬫椂闂存埑锛堟绉掞級 - 鐢卞閮ㄨ缃?*/
    private requestStartTime?: number;

    /** 褰撳墠璇锋眰鐨勫伐鍏锋ā寮?*/
    private readonly toolMode: ToolMode;

    /** 褰撳墠璇锋眰鐨勫伐鍏疯皟鐢?ID 宸ュ巶 */
    private readonly createToolCallId: () => string;

    /** Prompt 妯″紡涓嬬殑澧為噺宸ュ叿瑙ｆ瀽鍣?*/
    private promptToolParser?: IncrementalPromptToolParser;

    constructor(
        toolMode: ToolMode = 'function_call',
        createToolCallId: () => string = () => `fc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    ) {
        this.toolMode = toolMode;
        this.createToolCallId = createToolCallId;

        if (toolMode === 'json' || toolMode === 'xml') {
            this.promptToolParser = new IncrementalPromptToolParser(toolMode);
        }
    }

    /**
     * 鑾峰彇宸ュ叿妯″紡
     */
    private getToolMode(): ToolMode {
        return this.toolMode;
    }

    /**
     * 鍚堝苟澧為噺 usage 淇℃伅
     *
     * 鏌愪簺娓犻亾锛堝 Anthropic锛変細鎶婅緭鍏?杈撳嚭 token 鍒嗗埆鏀惧湪涓嶅悓浜嬩欢閲岋紝
     * 杩欓噷闇€瑕佸仛澧為噺鍚堝苟锛岄伩鍏嶅悗鍒拌揪鐨勫瓧娈佃鐩栧厛鍒拌揪鐨勫瓧娈点€?
     */
    private mergeUsageMetadata(usage: StreamUsageMetadata): void {
        const previous = this.usageMetadata;

        if (usage.totalTokenCount !== undefined) {
            this.hasProviderTotalTokenCount = true;
        }

        const merged: UsageMetadata = {
            promptTokenCount: usage.promptTokenCount ?? previous?.promptTokenCount,
            candidatesTokenCount: usage.candidatesTokenCount ?? previous?.candidatesTokenCount,
            totalTokenCount: usage.totalTokenCount ?? previous?.totalTokenCount,
            cachedContentTokenCount: usage.cachedContentTokenCount ?? previous?.cachedContentTokenCount,
            thoughtsTokenCount: usage.thoughtsTokenCount ?? previous?.thoughtsTokenCount,
            promptTokensDetails: usage.promptTokensDetails ?? previous?.promptTokensDetails,
            candidatesTokensDetails: usage.candidatesTokensDetails ?? previous?.candidatesTokensDetails
        };

        const hasAnyTokenField = merged.promptTokenCount !== undefined ||
            merged.candidatesTokenCount !== undefined ||
            merged.thoughtsTokenCount !== undefined;

        // 鏌愪簺娴佸紡娓犻亾锛堝 Anthropic锛変笉浼氱洿鎺ョ粰 totalTokenCount銆?
        // 褰撴湭鏀跺埌杩囨笭閬撳師鐢?total 鏃讹紝姣忔鍚堝苟鍚庨兘鐢ㄥ凡鐭ュ瓧娈甸噸绠楋紝
        // 閬垮厤鍑虹幇鍏堟敹鍒?prompt锛屽悗鏀跺埌 candidates 鏃?total 浠嶅仠鐣欏湪 prompt 鐨勯棶棰樸€?
        if (hasAnyTokenField) {
            const prompt = merged.promptTokenCount ?? 0;
            const candidates = merged.candidatesTokenCount ?? 0;
            const thoughts = merged.thoughtsTokenCount ?? 0;

            if (!this.hasProviderTotalTokenCount) {
                merged.totalTokenCount = prompt + candidates + thoughts;
            } else if (merged.totalTokenCount === undefined) {
                // 鐞嗚涓婃湁鍘熺敓 total 鏃朵笉搴旇繘鍏ユ鍒嗘敮锛屼絾涓虹ǔ鍋ユ€т繚搴曘€?
                merged.totalTokenCount = prompt + candidates + thoughts;
            }
        }

        this.usageMetadata = merged;
    }

    /**
     * 娣诲姞娴佸紡鍝嶅簲鍧?
     *
     * 澶勭悊娴佺▼锛?
     * 1. 绱姞澧為噺鍐呭锛坉elta锛?
     * 2. 鏇存柊 usage銆乫inishReason銆乵odelVersion 绛夊厓鏁版嵁
     * 3. 鏍囪瀹屾垚鐘舵€?
     *
     * 娉ㄦ剰锛歄penAI 鏍煎紡鐨勬祦寮忓搷搴斾腑锛寀sage 鍙兘鍦ㄥ崟鐙殑 chunk 涓彂閫?
     * 锛坈hoices 涓虹┖鏁扮粍浣嗘湁 usage 鏁版嵁锛夛紝鎵€浠ュ嵆浣垮凡缁?done锛?
     * 浠嶇劧闇€瑕佹帴鏀?usage 鏇存柊銆?
     *
     * @param chunk 娴佸紡鍝嶅簲鍧?
     */
    add(chunk: StreamChunk): ContentPart[] {
        const now = Date.now();
        const visibleDelta: ContentPart[] = [];

        // 澧炲姞鍧楄鏁?
        this.chunkCount++;

        // 璁板綍绗竴涓潡鐨勬椂闂?
        if (this.chunkCount === 1) {
            this.firstChunkTime = now;
        }

        // 鏇存柊鏈€鍚庝竴涓潡鐨勬椂闂?
        this.lastChunkTime = now;

        // 绱姞澧為噺鍐呭锛堝鏋滄湁锛?
        // 鍗充娇宸茬粡 done锛屼篃瑕佸鐞?delta锛堣櫧鐒堕€氬父 done 鍚?delta 涓虹┖锛?
        if (chunk.delta && chunk.delta.length > 0) {
            for (const part of chunk.delta) {
                this.addPart(part, { visibleDelta });
            }
        }

        if (chunk.done && this.promptToolParser) {
            const trailingParts = this.promptToolParser.flushIncompleteAsText();
            for (const part of trailingParts) {
                this.addPart(part, { skipPromptParser: true, visibleDelta });
            }
        }

        // 淇濆瓨瀹屾暣鐨?token 浣跨敤缁熻锛堝寘鎷妯℃€佽鎯咃級
        // 杩欎釜鍙兘鍦ㄧ涓€涓?done chunk 涓紝涔熷彲鑳藉湪鍚庣画鐨?usage chunk 涓?
        if (chunk.usage) {
            this.mergeUsageMetadata(chunk.usage);
        }

        // 淇濆瓨缁撴潫鍘熷洜锛堝鏋滄湁锛?
        if (chunk.finishReason) {
            this.finishReason = chunk.finishReason;
        }

        // 淇濆瓨妯″瀷鐗堟湰锛堝鏋滄湁锛?
        if (chunk.modelVersion) {
            this.modelVersion = chunk.modelVersion;
        }

        const stoppedAnthropicFunctionCallBlock =
            this.providerType === 'anthropic' &&
            chunk.providerEvent?.type === 'content_block_stop' &&
            typeof chunk.providerEvent.contentIndex === 'number' &&
            this.parts.some(part => part.functionCall && (part.functionCall as any).index === chunk.providerEvent?.contentIndex);
        const shouldEmitStructuralSnapshot =
            stoppedAnthropicFunctionCallBlock ||
            (this.providerType === 'anthropic' && chunk.providerEvent?.type === 'message_stop');
        if (shouldEmitStructuralSnapshot) {
            const stoppedIndex = stoppedAnthropicFunctionCallBlock ? chunk.providerEvent?.contentIndex : undefined;
            // Anthropic 鐨?content_block_stop 鍙粓缁撳搴?content_block.index锛沵essage_stop 鎵嶆竻鐞嗘墍鏈夊唴閮ㄥ瓧娈点€?
            // 鍓嶇浠嶉€氳繃缁熶竴 snapshot 鍚堝苟鍏ュ彛鏀舵潫宸ュ叿鍗★紝涓嶅仛 provider 鐗瑰垽銆?
            chunk.contentSnapshot = this.buildContent({
                parsePartialArgs: stoppedIndex === undefined,
                includeInternalFunctionCallFields: stoppedIndex !== undefined,
                warnOnParseFailure: false,
                finalizeFunctionCallIndex: stoppedIndex
            });
        }

        // 鏇存柊瀹屾垚鐘舵€?
        if (chunk.done) {
            this.isDone = true;
        }

        return visibleDelta;
    }

    /**
     * 璁剧疆 API 鎻愪緵鍟嗙被鍨?
     * 鐢ㄤ簬纭畾鎬濊€冪鍚嶇殑瀛樺偍鏍煎紡
     */
    setProviderType(type: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom'): void {
        this.providerType = type;
    }

    /**
     * 鑾峰彇 API 鎻愪緵鍟嗙被鍨?
     */
    getProviderType(): 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' {
        return this.providerType;
    }

    /**
     * 娣诲姞鍗曚釜 part
     *
     * 绠€鍖栫瓥鐣ワ細鐩存帴瀛樺偍 API 杩斿洖鐨勫師濮?part 鏍煎紡
     * - 鏂囨湰 part锛氬皾璇曚笌鐩稿悓绫诲瀷鐨勬渶鍚庝竴涓?part 鍚堝苟
     * - 闈炴枃鏈?part锛坒unctionCall銆乼houghtSignature 绛夛級锛氱洿鎺ユ坊鍔狅紝淇濇寔鍘熷缁撴瀯
     */
    private addPart(
        part: ContentPart,
        options?: {
            skipPromptParser?: boolean;
            visibleDelta?: ContentPart[];
        }
    ): void {
        if (!options?.skipPromptParser && this.promptToolParser && part.text && !part.thought) {
            const parsedParts = this.promptToolParser.appendText(part.text);
            for (const parsedPart of parsedParts) {
                this.addPart(parsedPart, {
                    skipPromptParser: true,
                    visibleDelta: options?.visibleDelta
                });
            }
            return;
        }

        // 娉ㄦ剰锛氫笉鍦ㄦ澶勪负 functionCall 鐢熸垚 id銆?
        // id 鐨勭敓鎴愭帹杩熷埌鍚堝苟閫昏緫纭鏃犳硶鍚堝苟銆侀渶瑕佷綔涓烘柊 Part 鎺ㄥ叆鏃跺啀鎵ц锛堣涓嬫柟 newPart 鏋勫缓澶勶級銆?

        // 渚嬪锛歱rompt 妯″紡锛坖son/xml锛夌殑澧為噺瑙ｆ瀽鍣ㄥ彧浼氫骇鍑衡€滃畬鏁村伐鍏疯皟鐢ㄥ潡鈥濓紝
        // 涓嶄細鍐嶈蛋 partialArgs/index 鐨勬祦寮忓悎骞惰矾寰勩€?
        // 杩欓噷鎻愬墠琛ヤ竴涓ǔ瀹?id锛屼繚璇侊細
        // 1. visibleDelta 閲岀殑 functionCall 甯︽湁 id
        // 2. 鍚庣画鍐欏叆 this.parts 鏃舵部鐢ㄥ悓涓€涓?id
        // 3. 涓嶅奖鍝?function_call 妯″紡涓嬬殑澧為噺鍚堝苟鍒ゆ柇
        if (
            this.promptToolParser &&
            part.functionCall &&
            !(part.functionCall as any).id &&
            (part.functionCall as any).partialArgs === undefined &&
            typeof (part.functionCall as any).index !== 'number'
        ) {
            (part.functionCall as any).id = this.createToolCallId();
        }

        if (options?.visibleDelta && part.text !== undefined) {
            options.visibleDelta.push(part.thought ? { text: part.text, thought: true } : { text: part.text });
        } else if (options?.visibleDelta && part.functionCall) {
            options.visibleDelta.push({ functionCall: { ...(part.functionCall as any) } });
        }

        // 鎻愬彇 thoughtSignature 鐢ㄤ簬鍐呴儴杩借釜
        if ((part as any).thoughtSignature) {
            this.thoughtSignatures[this.providerType] = (part as any).thoughtSignature;
        }
        if (part.thoughtSignatures) {
            Object.assign(this.thoughtSignatures, part.thoughtSignatures);
        }

        const isFunctionCall = !!(part as any).functionCall;

        // 澶勭悊闈炴枃鏈?part
        if (!('text' in part)) {
            if (part.functionCall && this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
                this.hasReceivedNormalText = true;
                this.thinkingDuration = Date.now() - this.thinkingStartTime;
            }

            if (part.functionCall) {
                const fc = part.functionCall as any;

                // 娉ㄦ剰锛氫笉鍦ㄦ澶勪负 fc 鐢熸垚 id锛屽惁鍒欎細鐮村潖涓嬫柟"绾閲忔ā寮?锛?fc.id锛夌殑鍚堝苟鍒ゆ柇
                // 鍊掑簭鎼滅储鐜版湁鐨?parts锛屽鎵惧彲浠ュ悎骞剁殑宸ュ叿璋冪敤鍧?
                // 瑙ｅ喅骞惰璋冪敤鎴栦腑闂寸┛鎻掑叾浠栨秷鎭鑷寸殑 lastPart 鍖归厤澶辫触闂
                for (let i = this.parts.length - 1; i >= 0; i--) {
                    const existingPart = this.parts[i];
                    if (!existingPart.functionCall) continue;

                    const lastFc = existingPart.functionCall as any;

                    // 浼樺寲鍚堝苟鍒ゆ柇閫昏緫
                    let canMerge = false;

                    const incomingItemId = typeof fc.itemId === 'string' && fc.itemId.trim() ? fc.itemId.trim() : '';
                    const lastItemId = typeof lastFc.itemId === 'string' && lastFc.itemId.trim() ? lastFc.itemId.trim() : '';
                    const sameItemId = incomingItemId && lastItemId && incomingItemId === lastItemId;
                    const lastIsFreshTool =
                        (!lastFc.args || Object.keys(lastFc.args).length === 0) &&
                        (lastFc.partialArgs === undefined || lastFc.partialArgs === '');

                    const sameIndex = typeof fc.index === 'number' && typeof lastFc.index === 'number' && fc.index === lastFc.index;

                    // OpenAI 妯″紡锛氫紭鍏堜娇鐢?index 鍖归厤锛堟暟瀛楃被鍨嬶紝鍖呮嫭 0锛?
                    if (sameIndex) {
                        canMerge = true;
                    }
                    // OpenAI Responses 鐨?item_id 鍙敤浜庢祦寮忎簨浠跺畾浣嶏紝蹇呴』鍚堝苟鍒板崰浣?function_call锛屼笉鑳戒綔涓烘渶缁堝伐鍏?ID銆?
                    else if (sameItemId) {
                        canMerge = true;
                    }
                    // Anthropic 妯″紡锛氫娇鐢?id 鏍囪瘑
                    else if (fc.id && lastFc.id) {
                        canMerge = fc.id === lastFc.id;
                    }
                    // 鍏煎娴佸彲鑳界渷鐣?output_index锛涙鏃舵妸鍙傛暟澧為噺鍚堝苟鍒版渶鍚庝竴涓垰鍒涘缓鐨勭┖宸ュ叿澹炽€?
                    else if (!fc.id && typeof fc.index !== 'number' && fc.partialArgs !== undefined && i === this.parts.length - 1 && lastIsFreshTool) {
                        canMerge = true;
                    }
                    // 绾閲忔ā寮忥細娌℃湁 id 涔熸病鏈?index锛屼絾鏈?partialArgs锛屼笖鏄渶鍚庝竴涓?FC
                    else if (!fc.id && typeof fc.index !== 'number' && fc.partialArgs !== undefined && i === this.parts.length - 1) {
                        canMerge = true;
                    }

                    if (canMerge) {
                        // 鍚堝苟鍚嶇О锛堝鏋滄湁锛?
                        if (fc.name && !lastFc.name) {
                            lastFc.name = fc.name;
                        }
                        // 鍚堝苟 ID锛汻esponses 鐨勫畼鏂?call_id 鍒拌揪杈冩櫄鏃讹紝鍙湪 itemId/index 宸茶瘉鏄庡悓婧愬悗瑕嗙洊鍗犱綅 id銆?
                        if (fc.id && (!lastFc.id || (this.providerType === 'openai-responses' && (sameItemId || sameIndex)))) {
                            lastFc.id = fc.id;
                        }
                        // itemId 浠呯敤浜庡悗缁祦寮忕墖娈靛畾浣嶏紝鏈€缁?Content 浼氱粺涓€鍒犻櫎銆?
                        if (fc.itemId && !lastFc.itemId) {
                            lastFc.itemId = fc.itemId;
                        }
                        // 鍚堝苟 index锛堝鏋滄湁锛?
                        if (typeof fc.index === 'number' && typeof lastFc.index !== 'number') {
                            lastFc.index = fc.index;
                        }
                        // Anthropic delta 鍙湁 index 娌℃湁 tool_use.id锛沬ndex 鍛戒腑鏃朵繚鐣欏凡鏈夊畼鏂?id锛岀淮鎸?id/index 璇箟鍒嗙銆?
                        // 鍚堝苟鎬濊€冪鍚嶇瓑鍏朵粬灞炴€?
                        if (part.thoughtSignatures) {
                            existingPart.thoughtSignatures = {
                                ...(existingPart.thoughtSignatures || {}),
                                ...part.thoughtSignatures
                            };
                        }
                        if ((part as any).thoughtSignature) {
                            existingPart.thoughtSignatures = {
                                ...(existingPart.thoughtSignatures || {}),
                                [this.providerType]: (part as any).thoughtSignature
                            };
                        }
                        // 鍚堝苟 partialArgs
                        if (fc.partialArgs !== undefined) {
                            // finalArgs 琛ㄧず瀹屾暣 arguments锛屽簲瑕嗙洊鑰屼笉鏄户缁拷鍔犲埌澧為噺 JSON銆?
                            lastFc.partialArgs = fc.finalArgs === true
                                ? fc.partialArgs
                                : (lastFc.partialArgs || '') + fc.partialArgs;

                            // Responses 鐨?arguments.delta 鏄崐鎴?JSON锛岄伩鍏嶅湪楂橀鐑矾寰勯€愮墖娈?JSON.parse銆?
                            const shouldParseNow = this.providerType !== 'openai-responses' || fc.finalArgs === true;
                            if (shouldParseNow && lastFc.partialArgs.trim()) {
                                try {
                                    const parsed = JSON.parse(lastFc.partialArgs);
                                    lastFc.args = parsed;
                                } catch (e) {
                                    // 瑙ｆ瀽澶辫触锛圝SON 涓嶅畬鏁达級锛岀户缁瓑寰呮洿澶氬閲忋€?
                                    // 姝ゅ涓嶆墦鏃ュ織鈥斺€旀祦寮忓閲忎腑 JSON 涓嶅畬鏁存槸姝ｅ父鐜拌薄銆?
                                }
                            }
                        }
                        return; // 鎴愬姛鍚堝苟锛岀洿鎺ヨ繑鍥?
                    }
                }

                // 鎵句笉鍒板彲鍚堝苟鍧楁椂浣滀负鏂板潡娣诲姞锛汻esponses 鍗婃埅 JSON 鍙湪 finalArgs 杈圭晫瑙ｆ瀽銆?
                if (fc.partialArgs && (this.providerType !== 'openai-responses' || fc.finalArgs === true)) {
                    try {
                        fc.args = JSON.parse(fc.partialArgs);
                    } catch (e) {}
                }

                // 鏋勫缓鏂?Part锛屼絾鎺掗櫎 API 鍘熷鏍煎紡鐨?thoughtSignature锛堝崟鏁帮級
                const { thoughtSignature: rawSignature, ...restPart } = part as any;
                const newPart: ContentPart = { ...restPart };
                // 纭繚 functionCall 鏄繁鎷疯礉鐨勶紝涓斿鐞嗕簡 args
                newPart.functionCall = { ...fc };
                // 鍙湪浣滀负鏂?Part 鎺ㄥ叆鏃舵墠鐢熸垚 id锛涘甫 itemId 鐨?Responses 鍗犱綅绛夊緟瀹樻柟 call_id銆?
                if (!newPart.functionCall.id && !(this.providerType === 'openai-responses' && (newPart.functionCall as any).itemId)) {
                    (newPart.functionCall as any).id = this.createToolCallId();
                }
                if (fc.args) newPart.functionCall.args = { ...fc.args };

                // 濡傛灉鏈?API 鍘熷鏍煎紡鐨?thoughtSignature锛岃浆鎹负 thoughtSignatures 鏍煎紡
                if (rawSignature) {
                    newPart.thoughtSignatures = {
                        ...(newPart.thoughtSignatures || {}),
                        [this.providerType]: rawSignature
                    };
                }

                this.parts.push(newPart);
                return;
            }

            // 鍏朵粬闈炴枃鏈?Part锛堝鍥剧墖銆佹枃浠剁瓑锛?
            // 鎺掗櫎 API 鍘熷鏍煎紡鐨?thoughtSignature锛堝崟鏁帮級锛岃浆鎹负 thoughtSignatures 鏍煎紡
            const { thoughtSignature: rawSig, ...restNonTextPart } = part as any;
            const nonTextPart: ContentPart = { ...restNonTextPart };
            if (rawSig) {
                nonTextPart.thoughtSignatures = {
                    ...(nonTextPart.thoughtSignatures || {}),
                    [this.providerType]: rawSig
                };
            }
            this.parts.push(nonTextPart);
            return;
        }

        // 鏂囨湰 part锛氬皾璇曞悎骞?
        const isThought = part.thought === true;

        // 鎬濊€冭鏃堕€昏緫
        if (isThought) {
            // 璁板綍鎬濊€冨紑濮嬫椂闂达紙浠呴娆★級
            if (this.thinkingStartTime === undefined) {
                this.thinkingStartTime = Date.now();
            }
        } else if (part.text) {
            // 鏀跺埌鏅€氭枃鏈椂锛岃绠楁€濊€冩寔缁椂闂?
            if (this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
                this.hasReceivedNormalText = true;
                this.thinkingDuration = Date.now() - this.thinkingStartTime;
            }
        }

        const lastPart = this.parts[this.parts.length - 1];

        // 妫€鏌ユ槸鍚﹀彲浠ヤ笌鏈€鍚庝竴涓?part 鍚堝苟锛堥兘鏄枃鏈笖鎬濊€冪被鍨嬬浉鍚岋級
        if (lastPart && 'text' in lastPart && !lastPart.functionCall) {
            const lastIsThought = lastPart.thought === true;

            if (lastIsThought === isThought) {
                lastPart.text += part.text;
                // 妫€娴嬪苟杞崲瀹屾暣鐨?JSON 宸ュ叿璋冪敤
                this.extractAndConvertToolCalls();
                return;
            }
        }

        // 鏃犳硶鍚堝苟锛屾坊鍔犳柊 part
        // 鎺掗櫎 API 鍘熷鏍煎紡鐨?thoughtSignature锛堝崟鏁帮級锛岃浆鎹负 thoughtSignatures 鏍煎紡
        const { thoughtSignature: rawTextSig, ...restTextPart } = part as any;
        const textPart: ContentPart = { ...restTextPart };
        if (rawTextSig) {
            textPart.thoughtSignatures = {
                ...(textPart.thoughtSignatures || {}),
                [this.providerType]: rawTextSig
            };
        }
        this.parts.push(textPart);
        // 妫€娴嬪苟杞崲瀹屾暣鐨?JSON 宸ュ叿璋冪敤
        this.extractAndConvertToolCalls();
    }

    /**
     * 妫€娴嬪苟杞崲鏂囨湰涓殑宸ュ叿璋冪敤鏍囪涓?functionCall
     * 鏍规嵁 toolMode 閫夋嫨瑙ｆ瀽鐨勬牸寮忥細
     * - 'xml': 瑙ｆ瀽 <tool_use>...</tool_use>
     * - 'json': 瑙ｆ瀽 <<<TOOL_CALL>>>...<<<END_TOOL_CALL>>>
     * - 'function_call': 涓嶈В鏋愭枃鏈爣璁帮紙鐢?API 杩斿洖 functionCall锛?
     * 瀹炴椂澶勭悊锛岃鍓嶇鑳界珛鍗虫樉绀哄伐鍏疯皟鐢ㄧ粍浠?
     */
    private extractAndConvertToolCalls(): void {
        // 鑾峰彇褰撳墠宸ュ叿妯″紡
        const toolMode = this.getToolMode();

        // function_call 妯″紡涓嶉渶瑕佽В鏋愭枃鏈爣璁?
        if (toolMode === 'function_call') {
            return;
        }

        const newParts: ContentPart[] = [];

        for (const part of this.parts) {
            if (!('text' in part)) {
                newParts.push(part);
                continue;
            }

            // 鏍规嵁 toolMode 閫夋嫨妫€鏌ョ殑鏍囪
            const hasJsonMarker = toolMode === 'json' && part.text.includes(TOOL_CALL_START);
            const hasXmlMarker = toolMode === 'xml' && part.text.includes(XML_TOOL_START);

            if (!hasJsonMarker && !hasXmlMarker) {
                newParts.push(part);
                continue;
            }

            let text = part.text;
            const isThought = part.thought === true;

            // 寰幆鎻愬彇鎵€鏈夊畬鏁寸殑宸ュ叿璋冪敤
            // 鏍规嵁 toolMode 鍙В鏋愬搴旀牸寮忥紝閬垮厤璇В鏋愪唬鐮佺ず渚嬩腑鐨勬爣璁?
            while (true) {
                if (toolMode === 'json') {
                    // JSON 妯″紡锛氬彧妫€鏌?JSON 鏍煎紡鏍囪
                    const jsonStartIdx = text.indexOf(TOOL_CALL_START);
                    const jsonEndIdx = text.indexOf(TOOL_CALL_END);

                    if (jsonStartIdx === -1 || jsonEndIdx === -1 || jsonEndIdx <= jsonStartIdx) {
                        break;
                    }

                    // 澶勭悊 JSON 鏍煎紡
                    const textBefore = text.substring(0, jsonStartIdx).trim();
                    if (textBefore) {
                        newParts.push(isThought ? { text: textBefore, thought: true } : { text: textBefore });
                    }

                    const jsonStart = jsonStartIdx + TOOL_CALL_START.length;
                    const jsonStr = text.substring(jsonStart, jsonEndIdx).trim();

                    try {
                        const toolCall = JSON.parse(jsonStr);
                        if (toolCall.tool && toolCall.parameters) {
                            newParts.push({
                                functionCall: {
                                    name: toolCall.tool,
                                    args: toolCall.parameters,
                                    id: this.createToolCallId()
                                }
                            });
                        } else {
                            // 鏍煎紡涓嶆纭紝淇濈暀鍘熸枃鏈?
                            newParts.push({ text: text.substring(jsonStartIdx, jsonEndIdx + TOOL_CALL_END.length) });
                        }
                    } catch {
                        // JSON 瑙ｆ瀽澶辫触锛屼繚鐣欏師鏂囨湰
                        newParts.push({ text: text.substring(jsonStartIdx, jsonEndIdx + TOOL_CALL_END.length) });
                    }

                    text = text.substring(jsonEndIdx + TOOL_CALL_END.length);
                } else if (toolMode === 'xml') {
                    // XML 妯″紡锛氬彧妫€鏌?XML 鏍煎紡鏍囪
                    const xmlStartIdx = text.indexOf(XML_TOOL_START);
                    const xmlEndIdx = text.indexOf(XML_TOOL_END);

                    if (xmlStartIdx === -1 || xmlEndIdx === -1 || xmlEndIdx <= xmlStartIdx) {
                        break;
                    }

                    // 澶勭悊 XML 鏍煎紡
                    const textBefore = text.substring(0, xmlStartIdx).trim();
                    if (textBefore) {
                        newParts.push(isThought ? { text: textBefore, thought: true } : { text: textBefore });
                    }

                    const xmlContent = text.substring(xmlStartIdx, xmlEndIdx + XML_TOOL_END.length);

                    try {
                        const xmlCalls = parseXMLToolCalls(xmlContent);
                        if (xmlCalls.length > 0) {
                            for (const xmlCall of xmlCalls) {
                                newParts.push({
                                    functionCall: {
                                        name: xmlCall.name,
                                        args: xmlCall.args,
                                        id: this.createToolCallId()
                                    }
                                });
                            }
                        } else {
                            // 瑙ｆ瀽澶辫触锛屼繚鐣欏師鏂囨湰
                            newParts.push({ text: xmlContent });
                        }
                    } catch {
                        // XML 瑙ｆ瀽澶辫触锛屼繚鐣欏師鏂囨湰
                        newParts.push({ text: xmlContent });
                    }

                    text = text.substring(xmlEndIdx + XML_TOOL_END.length);
                } else {
                    // 鏈煡妯″紡锛岄€€鍑哄惊鐜?
                    break;
                }
            }

            // 娣诲姞鍓╀綑鏂囨湰
            if (text) {
                newParts.push(isThought ? { text, thought: true } : { text });
            }
        }

        this.parts = newParts;
    }

    /**
     * 鏋勯€?Content 鐨勫敮涓€鍐呴儴鍏ュ彛銆?
     * streaming snapshot 鍙仛杞婚噺鎶曞奖锛涙渶缁堝啓鍘嗗彶鎴栧伐鍏锋墽琛屽墠鎵嶈В鏋?partialArgs 骞舵竻鐞嗗唴閮ㄥ瓧娈点€?
     */
    private buildContent(options: BuildContentOptions): Content {
        let parts = this.parts
            .map(p => {
                const part = { ...p };
                if (part.functionCall) {
                    const fc = { ...part.functionCall } as any;
                    const shouldFinalizeFunctionCall =
                        typeof options.finalizeFunctionCallIndex === 'number' &&
                        typeof fc.index === 'number' &&
                        fc.index === options.finalizeFunctionCallIndex;
                    if ((options.parsePartialArgs || shouldFinalizeFunctionCall) && fc.partialArgs && (!fc.args || Object.keys(fc.args).length === 0)) {
                        try {
                            fc.args = JSON.parse(fc.partialArgs);
                        } catch (e) {
                            if (options.warnOnParseFailure) {
                                const fnName = fc.name || 'unknown';
                                const preview = String(fc.partialArgs || '').slice(0, 200);
                                console.warn(`[StreamAccumulator] Failed to parse tool "${fnName}" partialArgs: ${preview}`);
                            }
                        }
                    }

                    if (!options.includeInternalFunctionCallFields || shouldFinalizeFunctionCall) {
                        delete fc.index;
                        delete fc.partialArgs;
                        // itemId/finalArgs 鍙槸娴佸紡鍚堝苟瀛楁锛屾渶缁?Content 鍙繚鐣欒法 provider 閫氱敤鍗忚銆?
                        delete fc.itemId;
                        delete fc.finalArgs;
                    }
                    part.functionCall = fc;
                }
                return part;
            })
            .filter(p => {
                // 淇濈暀闈炴枃鏈?part锛坒unctionCall 绛夛級
                if (!('text' in p) || p.functionCall) return true;
                // 杩囨护绌烘枃鏈紙浣嗕繚鐣欐湁鎰忎箟鐨勫唴瀹癸級
                if ('text' in p && p.text === '' && !p.thought) return false;
                return true;
            });

        // 娣诲姞鎬濊€冪鍚嶅埌 parts 涓?
        // 濡傛灉鏈夋敹闆嗗埌鐨勬€濊€冪鍚嶏紝闇€瑕佷綔涓哄崟鐙殑 part 娣诲姞
        // 杩欐牱鍙互鍦ㄥ悗缁彂閫佺粰 API 鏃舵纭紶閫掔鍚?
        if (Object.keys(this.thoughtSignatures).length > 0) {
            // 妫€鏌?parts 涓槸鍚﹀凡缁忔湁鍖呭惈 thoughtSignatures 鐨?part
            const hasSignaturePart = parts.some(p => p.thoughtSignatures);
            if (!hasSignaturePart) {
                // 娣诲姞涓€涓寘鍚墍鏈夋牸寮忕鍚嶇殑 part
                parts.push({ thoughtSignatures: { ...this.thoughtSignatures } });
            }
        }

        const content: Content = {
            role: 'model',
            parts
        };

        // 娣诲姞妯″瀷鐗堟湰
        if (this.modelVersion) {
            content.modelVersion = this.modelVersion;
        }

        // 娣诲姞瀹屾暣鐨?usageMetadata
        if (this.usageMetadata) {
            content.usageMetadata = { ...this.usageMetadata };
        }

        // 娣诲姞鎬濊€冨紑濮嬫椂闂达紙鐢ㄤ簬鍓嶇瀹炴椂鏄剧ず锛?
        if (this.thinkingStartTime !== undefined) {
            content.thinkingStartTime = this.thinkingStartTime;
        }

        // 娣诲姞鎬濊€冩寔缁椂闂?
        // 濡傛灉鏈夋€濊€冨唴瀹逛絾娌℃湁鏅€氭枃鏈紝鍦ㄨ幏鍙?Content 鏃惰绠楁渶缁堟寔缁椂闂?
        if (this.thinkingStartTime !== undefined) {
            if (this.thinkingDuration !== undefined) {
                content.thinkingDuration = this.thinkingDuration;
            } else if (!this.hasReceivedNormalText) {
                // 娑堟伅鍙湁鎬濊€冨唴瀹规病鏈夋櫘閫氭枃鏈紝浣跨敤褰撳墠鏃堕棿璁＄畻
                content.thinkingDuration = Date.now() - this.thinkingStartTime;
            }
        }

        // 娣诲姞娴佸紡缁熻淇℃伅
        content.chunkCount = this.chunkCount;
        if (this.firstChunkTime !== undefined) {
            content.firstChunkTime = this.firstChunkTime;
        }

        // 淇敼鍘熷洜锛氭棫 streamDuration 鍙鐩栭鍧楀埌鏈潡绐楀彛锛屼笂娓告敀鍖呭悗浼氳 token 閫熷害鍒嗘瘝杩囧皬銆?
        // 淇敼鏂瑰紡锛氱敤鍚屼竴涓?requestStartTime -> lastChunkTime / Date.now() 灞€閮ㄥ€煎悓鏃跺啓鍏?responseDuration 涓?streamDuration銆?
        // 淇敼鐩殑锛氬瓧闈慨澶?streamDuration 涓哄畬鏁磋姹傚埌娴佺粨鏉熻€楁椂锛屽苟閬垮厤涓や釜瀛楁鍥犻噸澶嶉噰鏍蜂骇鐢熸绉掔骇鎶栧姩銆?
        if (this.requestStartTime !== undefined) {
            const completeResponseDuration = (this.lastChunkTime ?? Date.now()) - this.requestStartTime;
            content.responseDuration = completeResponseDuration;
            content.streamDuration = completeResponseDuration;
        }

        return content;
    }

    /** 鑾峰彇娴佸紡鏍″噯蹇収锛涗繚鐣欏唴閮ㄥ悎骞跺瓧娈碉紝浣嗕笉瑙ｆ瀽鏈畬鎴愮殑 partialArgs銆?*/
    getStreamingContent(options?: StreamingContentOptions): Content {
        return this.buildContent({
            parsePartialArgs: false,
            includeInternalFunctionCallFields: options?.includeInternalFields ?? true,
            warnOnParseFailure: false
        });
    }

    /** 鑾峰彇鏈€缁堝唴瀹癸細瑙ｆ瀽 partialArgs锛屽苟娓呯悊 itemId/index/finalArgs 绛夊唴閮ㄥ瓧娈点€?*/
    getFinalContent(): Content {
        return this.buildContent({
            parsePartialArgs: true,
            includeInternalFunctionCallFields: false,
            warnOnParseFailure: true
        });
    }

    /**
     * 鍏煎鏃ц皟鐢ㄦ柟鐨勬渶缁?Content 鍏ュ彛銆?
     */
    getContent(): Content {
        return this.getFinalContent();
    }

    /**
     * 鑾峰彇褰撳墠鏂囨湰鍐呭锛堢敤浜庡疄鏃舵樉绀猴級
     *
     * @param options 閫夐」
     * @returns 褰撳墠绱姞鐨勬枃鏈?
     */
    getText(options?: {
        /** 鏄惁鍖呭惈鎬濊€冨唴瀹?*/
        includeThoughts?: boolean;
    }): string {
        const includeThoughts = options?.includeThoughts ?? false;

        return this.parts
            .filter(part => {
                if (!('text' in part)) {
                    return false;
                }
                // 濡傛灉涓嶅寘鍚€濊€冨唴瀹癸紝杩囨护鎺夋€濊€?part
                if (!includeThoughts && part.thought === true) {
                    return false;
                }
                return true;
            })
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 鑾峰彇鎬濊€冨唴瀹癸紙鍗曠嫭鑾峰彇锛?
     *
     * @returns 鎬濊€冨唴瀹规枃鏈?
     */
    getThoughts(): string {
        return this.parts
            .filter(part => 'text' in part && part.thought === true)
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 鑾峰彇鏅€氬唴瀹癸紙涓嶅惈鎬濊€冿級
     *
     * @returns 鏅€氬唴瀹规枃鏈?
     */
    getNormalText(): string {
        return this.parts
            .filter(part => 'text' in part && part.thought !== true)
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 妫€鏌ユ槸鍚﹀畬鎴?
     */
    isComplete(): boolean {
        return this.isDone;
    }

    /**
     * 鑾峰彇缁撴潫鍘熷洜
     */
    getFinishReason(): string | undefined {
        return this.finishReason;
    }

    /**
     * 鑾峰彇妯″瀷鐗堟湰
     */
    getModelVersion(): string | undefined {
        return this.modelVersion;
    }

    /**
     * 璁剧疆妯″瀷鐗堟湰
     */
    setModelVersion(modelVersion: string): void {
        this.modelVersion = modelVersion;
    }

    /**
     * 閲嶇疆绱姞鍣?
     */
    reset(): void {
        this.parts = [];
        this.isDone = false;
        this.usageMetadata = undefined;
        this.hasProviderTotalTokenCount = false;
        this.finishReason = undefined;
        this.modelVersion = undefined;
        this.thoughtSignatures = {};
        this.thinkingStartTime = undefined;
        this.thinkingDuration = undefined;
        this.hasReceivedNormalText = false;
        this.chunkCount = 0;
        this.firstChunkTime = undefined;
        this.lastChunkTime = undefined;
        this.requestStartTime = undefined;
        this.reportedFunctionCallIndices.clear();

        if (this.promptToolParser) {
            this.promptToolParser.reset();
        }
    }

    /**
     * 璁剧疆璇锋眰寮€濮嬫椂闂?
     * 淇敼鍘熷洜锛歵oken 閫熷害闇€瑕佸畬鏁磋姹傝€楁椂锛岃€屼笉鏄鍧楀埌鏈潡鐨勭煭娴佸嚭绐楀彛銆?
     * 淇敼鏂瑰紡锛氬悓涓€涓?requestStartTime 鍚屾椂椹卞姩 responseDuration 涓?streamDuration 鐨勫畬鏁磋€楁椂璁＄畻銆?
     * 淇敼鐩殑锛氫繚璇佸悗缁瀯閫?Content 鏃朵袱涓€楁椂瀛楁鍚屾簮锛岄伩鍏?SSE 鏀掑寘瀵艰嚧鐣搁珮閫熺巼銆?
     */
    setRequestStartTime(time: number): void {
        this.requestStartTime = time;
    }

    /**
     * 鑾峰彇娴佸紡鍧楄鏁?
     */
    getChunkCount(): number {
        return this.chunkCount;
    }

    /**
     * 鑾峰彇绗竴涓祦寮忓潡鏃堕棿
     */
    getFirstChunkTime(): number | undefined {
        return this.firstChunkTime;
    }

    /**
     * 鑾峰彇鏈€鍚庝竴涓祦寮忓潡鏃堕棿
     */
    getLastChunkTime(): number | undefined {
        return this.lastChunkTime;
    }

    /**
     * 鑾峰彇鎬濊€冪鍚嶏紙澶氭牸寮忥級
     */
    getThoughtSignatures(): ThoughtSignatures {
        return { ...this.thoughtSignatures };
    }

    /**
     * 鑾峰彇鎸囧畾鏍煎紡鐨勬€濊€冪鍚?
     */
    getThoughtSignature(format: string = 'gemini'): string | undefined {
        return this.thoughtSignatures[format];
    }

    /**
     * 鑾峰彇 token 浣跨敤缁熻
     */
    getUsageMetadata(): UsageMetadata | undefined {
        return this.usageMetadata ? { ...this.usageMetadata } : undefined;
    }

    /**
     * 鑾峰彇鍔犲瘑鎬濊€冨唴瀹?
     *
     * @returns 鍔犲瘑鎬濊€冨唴瀹规暟缁勶紙鍙兘鏈夊涓潡锛?
     */
    getRedactedThinking(): string[] {
        return this.parts
            .filter(part => part.redactedThinking)
            .map(part => part.redactedThinking!);
    }

    /** 鑾峰彇鎬濊€冨紑濮嬫椂闂达紱閬垮厤鍙负鍙戦€?thinkingStartTime 鑰屾瀯閫犲畬鏁?Content銆?*/
    getThinkingStartTime(): number | undefined {
        return this.thinkingStartTime;
    }

    /**
     * 鑾峰彇鎬濊€冩寔缁椂闂?
     */
    getThinkingDuration(): number | undefined {
        if (this.thinkingDuration !== undefined) {
            return this.thinkingDuration;
        }
        if (this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
            return Date.now() - this.thinkingStartTime;
        }
        return undefined;
    }

    /**
     * 鑾峰彇缁熻淇℃伅
     */
    getStats(): {
        partCount: number;
        textLength: number;
        thoughtsLength: number;
        normalTextLength: number;
        hasThoughts: boolean;
        hasRedactedThinking: boolean;
        hasThoughtSignatures: boolean;
        thoughtSignatureFormats: string[];
        usageMetadata?: UsageMetadata;
        thinkingDuration?: number;
        chunkCount: number;
        firstChunkTime?: number;
        lastChunkTime?: number;
    } {
        const signatureFormats = Object.keys(this.thoughtSignatures).filter(k => this.thoughtSignatures[k]);
        return {
            partCount: this.parts.length,
            textLength: this.getText({ includeThoughts: true }).length,
            thoughtsLength: this.getThoughts().length,
            normalTextLength: this.getNormalText().length,
            hasThoughts: this.parts.some(p => 'thought' in p && p.thought === true),
            hasRedactedThinking: this.parts.some(p => p.redactedThinking),
            hasThoughtSignatures: signatureFormats.length > 0,
            thoughtSignatureFormats: signatureFormats,
            usageMetadata: this.usageMetadata,
            thinkingDuration: this.getThinkingDuration(),
            chunkCount: this.chunkCount,
            firstChunkTime: this.firstChunkTime,
            lastChunkTime: this.lastChunkTime
        };
    }

    /**
     * 杩斿洖鑷笂娆¤皟鐢ㄤ互鏉ユ柊瀹屾垚锛坅rgs 宸茶В鏋愭垚鍔燂級鐨?functionCall銆?
     *
     * 鐢ㄤ簬娴佸紡杈规墽琛屽伐鍏凤細ToolIterationLoopService 鍦ㄦ祦寮忔秷璐瑰惊鐜腑
     * 姣忓鐞嗕竴涓?chunk 鍚庤皟鐢ㄦ鏂规硶锛屾娴嬫槸鍚︽湁鏂扮殑 functionCall 瀹屾垚锛?
     * 瀵逛笉闇€瑕佺‘璁ょ殑宸ュ叿绔嬪嵆鍚姩寮傛鎵ц銆?
     *
     * "瀹屾垚"鐨勫垽瀹氾細functionCall.args 宸叉湁鍊硷紙partialArgs 宸叉垚鍔?JSON.parse锛夈€?
     * 姣忎釜 functionCall 鍙細琚繑鍥炰竴娆★紙閫氳繃 reportedFunctionCallIndices 鍘婚噸锛夈€?
     */
    getNewCompletedFunctionCalls(): Array<{
        index: number;
        name: string;
        id: string;
        args: Record<string, unknown>;
    }> {
        const result: Array<{ index: number; name: string; id: string; args: Record<string, unknown> }> = [];

        for (let i = 0; i < this.parts.length; i++) {
            if (this.reportedFunctionCallIndices.has(i)) continue;

            const part = this.parts[i];
            if (!part.functionCall) continue;

            const fc = part.functionCall as any;
            // "瀹屾垚"鍒ゅ畾锛歛rgs 蹇呴』鍖呭惈鑷冲皯涓€涓敭锛屾帓闄ゅ垵濮嬪崰浣嶇┖澹?{}銆?
            //
            // Anthropic content_block_start 鍙戦€?input: {}锛宖ormatter 瀛樹负
            // args: {}锛汷penAI 棣栦釜 tool_call chunk 涔熻 args: {}銆?
            // 鐪熸鐨勫弬鏁伴€氳繃鍚庣画澧為噺锛坕nput_json_delta / arguments delta锛?
            // 鎷兼帴鍒?partialArgs锛孞SON.parse 鎴愬姛鍚庢墠鏇存柊 args銆?
            // 浠呮鏌?args 鏄惁涓哄璞′細鍦ㄥ垵濮嬮樁娈佃鍒や负瀹屾垚锛屽鑷翠互绌哄弬鏁版墽琛屻€?
            //
            // 鍙湁 partialArgs 琚垚鍔?JSON.parse 鍚庯紝args 鎵嶄細鍚湁瀹為檯鐨勯敭銆?
            const hasRealArgs = fc.args && typeof fc.args === 'object' && Object.keys(fc.args).length > 0;
            const hasStableToolCallId = typeof fc.id === 'string' && fc.id.trim().length > 0;
            // Responses 蹇呴』绛夊畼鏂?call_id 绋冲畾鍚庡啀鎻愬墠鎵ц锛屽惁鍒?functionResponse.id 浼氫笌鍚庣画涓婁笅鏂囪姹備笉涓€鑷淬€?
            if (hasRealArgs && fc.name && (this.providerType !== 'openai-responses' || hasStableToolCallId)) {
                this.reportedFunctionCallIndices.add(i);
                result.push({
                    index: i,
                    name: fc.name,
                    id: fc.id || '',
                    args: fc.args,
                });
            }
        }

        return result;
    }
}