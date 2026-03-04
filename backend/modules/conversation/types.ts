/**
 * LimCode - 瀵硅瘽鍘嗗彶绠＄悊绫诲瀷瀹氫箟
 * 
 * 瀹屾暣鏀寔 Gemini API 鏍煎紡,鍖呮嫭:
 * - 鏂囨湰銆佹枃浠躲€佸唴鑱旀暟鎹?
 * - 鍑芥暟璋冪敤鍜屽嚱鏁板搷搴?
 * - 鎬濊€冪鍚?Thinking)
 * - 鎬濊€冨唴瀹?Thought)
 * - 鎵€鏈夐珮绾х壒鎬?
 * 
 * 瀛樺偍鏍煎紡: 瀹屾暣鐨?Gemini Content[] 鏁扮粍
 * 鏂囦欢鍛藉悕: 浠ュ璇?ID 浣滀负鏂囦欢鍚?
 */

/**
 * 涓嶅悓娓犻亾鐨?Token 璁℃暟
 *
 * 鐢变簬涓嶅悓娓犻亾锛圙emini銆丱penAI銆丄nthropic锛夊鍚屼竴娑堟伅鐨?token 璁＄畻鏂瑰紡涓嶅悓锛?
 * 浣跨敤瀵硅薄缁撴瀯鍒嗗紑瀛樺偍锛屼究浜庢寜褰撳墠浣跨敤鐨勬笭閬撶被鍨嬭幏鍙栧搴旂殑 token 鏁般€?
 *
 * 璁＄畻鏂瑰紡锛?
 * - 閫氳繃璋冪敤鍚勬笭閬撶殑 token 璁℃暟 API 鑾峰彇绮剧‘鍊?
 * - 濡傛灉 API 璋冪敤澶辫触锛屽洖閫€鍒颁及绠楁柟娉?
 */
export interface ChannelTokenCounts {
    /** Gemini 娓犻亾鐨?token 鏁?*/
    gemini?: number;
    
    /** OpenAI 娓犻亾鐨?token 鏁?*/
    openai?: number;
    
    /** Anthropic 娓犻亾鐨?token 鏁?*/
    anthropic?: number;
    
    /** 鍏朵粬娓犻亾鐨?token 鏁?*/
    [key: string]: number | undefined;
}

/**
 * 鎬濊€冪鍚嶏紙澶氭牸寮忔敮鎸侊級
 *
 * 涓嶅悓 API 鎻愪緵鍟嗚繑鍥炵殑鎬濊€冪鍚嶆牸寮忎笉鍚岋紝
 * 浣跨敤瀵硅薄缁撴瀯鍒嗗紑瀛樺偍锛屼究浜庡尯鍒嗗拰绠＄悊
 *
 * 鎬濊€冪鍚嶇ず渚? "Eo4KCosKAXrI2nyWeryDa/51Rbxj4E/V/8w=="
 */
export interface ThoughtSignatures {
    /** Gemini 鏍煎紡鎬濊€冪鍚?*/
    gemini?: string;
    
    /** Anthropic 鏍煎紡鎬濊€冪鍚嶏紙棰勭暀锛?*/
    anthropic?: string;
    
    /** OpenAI 鏍煎紡鎬濊€冪鍚嶏紙棰勭暀锛?*/
    openai?: string;
    
    /** OpenAI Responses 鏍煎紡鎬濊€冪鍚?*/
    'openai-responses'?: string;
    
    /** 鍏朵粬鏍煎紡鎬濊€冪鍚?*/
    [key: string]: string | undefined;
}

/**
 * Gemini Content Part锛堝唴瀹圭墖娈碉級
 *
 * 鏀寔 Gemini API 鐨勬墍鏈夊唴瀹圭被鍨?
 * - text: 鏂囨湰鍐呭
 * - inlineData: Base64 缂栫爜鐨勫唴鑱旀暟鎹?鍥剧墖銆侀煶棰戠瓑)
 * - fileData: 鏂囦欢寮曠敤(閫氳繃 File API 涓婁紶鐨勬枃浠?
 * - functionCall: 妯″瀷璇锋眰璋冪敤鐨勫嚱鏁?
 * - functionResponse: 鍑芥暟鎵ц缁撴灉
 * - thoughtSignatures: 鎬濊€冪鍚?鐢ㄤ簬澶氳疆瀵硅瘽涓繚鎸佹€濊€冧笂涓嬫枃)
 * - thought: 鏄惁涓烘€濊€冨唴瀹规爣蹇?
 */
export interface ContentPart {
    /** 鏂囨湰鍐呭 */
    text?: string;
    
    /**
     * 鍐呰仈鏁版嵁(Base64 缂栫爜)
     *
     * 鏍囧噯 Gemini API 鍙渶瑕?mimeType 鍜?data銆?
     * - displayName: Gemini API 鏀寔鐨勬樉绀哄悕绉板瓧娈?
     * - id 鍜?name 鏄檮浠跺厓鏁版嵁锛屼粎鐢ㄤ簬瀛樺偍鍜屽墠绔樉绀猴紝
     *   鍙戦€佺粰 AI 鏃朵細琚繃婊ゆ帀銆?
     */
    inlineData?: {
        mimeType: string;
        data: string; // Base64 缂栫爜鐨勬暟鎹?
        /** 鏄剧ず鍚嶇О锛圙emini API 鏀寔锛屽彲鍙戦€佺粰 API锛?*/
        displayName?: string;
        /** 闄勪欢 ID锛堜粎鐢ㄤ簬瀛樺偍鍜屾樉绀猴紝鍙戦€?API 鏃惰繃婊わ級 */
        id?: string;
        /** 闄勪欢鍚嶇О锛堜粎鐢ㄤ簬瀛樺偍鍜屾樉绀猴紝鍙戦€?API 鏃惰繃婊わ級 */
        name?: string;
    };
    
    /**
     * 鏂囦欢鏁版嵁(File API 寮曠敤)
     *
     * displayName 鍦ㄤ互涓嬪満鏅腑蹇呴渶锛?
     * - 鍦?functionResponse.parts 涓紝闇€瑕侀€氳繃 {"$ref": "displayName"} 寮曠敤鏃?
     */
    fileData?: {
        mimeType: string;
        fileUri: string;
        displayName?: string; // 鐢ㄤ簬 JSON 寮曠敤鐨勫敮涓€鍚嶇О
    };
    
    /** 鍑芥暟璋冪敤(妯″瀷璇锋眰) */
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
        /** 澧為噺瑙ｆ瀽鏃剁殑鍘熷 JSON 瀛楃涓诧紙鐢ㄤ簬娴佸紡杈撳嚭锛?*/
        partialArgs?: string;
        id?: string; // 鍙€夌殑鍑芥暟璋冪敤 ID
        /**
         * 鏄惁宸茶鐢ㄦ埛鎷掔粷鎵ц
         *
         * 褰撶敤鎴峰湪宸ュ叿绛夊緟纭鏃剁偣鍑荤粓姝㈡寜閽紝姝ゅ瓧娈典細琚缃负 true
         * 鐢ㄤ簬鍦ㄩ噸鏂板姞杞藉璇濇椂姝ｇ‘鏄剧ず宸ュ叿鐘舵€?
         */
        rejected?: boolean;
    };
    
    /**
     * 鍑芥暟鍝嶅簲(鎵ц缁撴灉)
     *
     * Gemini 3 Pro+ 鏀寔澶氭ā鎬佸嚱鏁板搷搴旓細
     * - parts: 鍙互鍖呭惈 inlineData 鎴?fileData 鐨勫祵濂?parts
     * - response: 鍙互浣跨敤 {"$ref": "displayName"} 寮曠敤 parts 涓殑澶氭ā鎬佸唴瀹?
     * - id: 鍑芥暟璋冪敤 ID锛圓nthropic API 蹇呴渶锛岀敤浜庡叧鑱?tool_use 鍜?tool_result锛?
     *
     * 绀轰緥锛?
     * {
     *   "functionResponse": {
     *     "name": "get_image",
     *     "id": "toolu_xxx",
     *     "response": {
     *       "image_ref": { "$ref": "cat.jpg" }
     *     },
     *     "parts": [
     *       {
     *         "fileData": {
     *           "displayName": "cat.jpg",
     *           "mimeType": "image/jpeg",
     *           "fileUri": "gs://..."
     *         }
     *       }
     *     ]
     *   }
     * }
     */
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
        id?: string; // 鍑芥暟璋冪敤 ID锛圓nthropic 蹇呴渶锛?
        parts?: ContentPart[]; // 宓屽鐨勫妯℃€?parts (Gemini 3 Pro+)
    };
    
    /**
     * 鎬濊€冪鍚嶏紙澶氭牸寮忔敮鎸侊級
     *
     * 鎸夋彁渚涘晢鏍煎紡鍒嗙被瀛樺偍鐨勬€濊€冪鍚?
     *
     * 绀轰緥: { gemini: "Eo4KCosKAXLI2nyWeryDa/51Rbxj4E/V/8w==" }
     *
     * 浣跨敤鍦烘櫙:
     * - thoughtSignatures.gemini: Gemini API 杩斿洖鐨勭鍚?
     * - thoughtSignatures.anthropic: Anthropic API 杩斿洖鐨勭鍚嶏紙棰勭暀锛?
     * - thoughtSignatures.openai: OpenAI API 杩斿洖鐨勭鍚嶏紙棰勭暀锛?
     *
     * 鍙戦€佽姹傛椂锛屾牴鎹洰鏍?API 绫诲瀷閫夋嫨瀵瑰簲鏍煎紡鐨勭鍚嶅彂閫?
     *
     * 閲嶈瑙勫垯:
     * - 蹇呴』鍘熸牱杩斿洖缁欐ā鍨嬶紝涓嶈兘淇敼
     * - 涓嶈兘涓庡叾浠?part 鍚堝苟
     * - 涓嶈兘鍚堝苟涓や釜閮藉惈绛惧悕鐨?parts
     * - 瀵逛簬 Gemini 3 鍑芥暟璋冪敤锛氬繀椤昏繑鍥烇紝鍚﹀垯浼?400 閿欒
     * - 瀵逛簬鍏朵粬鎯呭喌锛氭帹鑽愯繑鍥炰互淇濇寔鎺ㄧ悊璐ㄩ噺
     */
    thoughtSignatures?: ThoughtSignatures;
    
    /**
     * 鏄惁涓烘€濊€冨唴瀹规爣蹇?
     *
     * 褰撹缃负 true 鏃讹紝琛ㄧず姝?part 鍖呭惈妯″瀷鐨勬€濊€冭繃绋嬭€岄潪鏈€缁堝洖绛旓細
     * - 鎬濊€冩憳瑕侊細褰?includeThoughts=true 鏃讹紝妯″瀷杩斿洖鐨勬帹鐞嗚繃绋?
     * - 涓庢鏂囧唴瀹瑰垎绂伙紝鐢ㄤ簬璋冭瘯鎴栦簡瑙ｆ帹鐞嗘楠?
     * - 涓嶅簲浣滀负鏈€缁堢瓟妗堝睍绀虹粰鐢ㄦ埛
     *
     * 绀轰緥 1 - 鎬濊€冨唴瀹?
     * {
     *   "text": "Let me think step-by-step about this problem...",
     *   "thought": true  // 杩欐槸鎬濊€冭繃绋?
     * }
     *
     * 绀轰緥 2 - 姝ｆ枃鍥炵瓟:
     * {
     *   "text": "The answer is 42",
     *   "thought": false // 鎴栫渷鐣ユ瀛楁锛岃繖鏄渶缁堝洖绛?
     * }
     *
     * 瀹屾暣鍝嶅簲绀轰緥:
     * {
     *   "role": "model",
     *   "parts": [
     *     {
     *       "text": "I need to calculate... step 1, step 2...",
     *       "thought": true  // 鎬濊€冭繃绋?
     *     },
     *     {
     *       "text": "Based on my analysis, the result is X",
     *       // thought 瀛楁鐪佺暐鎴栦负 false锛岃〃绀鸿繖鏄渶缁堝洖绛?
     *     }
     *   ]
     * }
     */
    thought?: boolean;
    
    /**
     * 鍔犲瘑鐨勬€濊€冨唴瀹癸紙Anthropic redacted_thinking锛?
     *
     * Anthropic Claude 鍦ㄦ煇浜涙儏鍐典笅浼氳繑鍥炲姞瀵嗙殑鎬濊€冨唴瀹癸紝
     * 浠?Base64 缂栫爜鐨勫舰寮忓瓨鍌ㄥ湪 redacted_thinking 鍧椾腑銆?
     *
     * 涓庢櫘閫氭€濊€冨唴瀹圭殑鍖哄埆锛?
     * - 鏅€氭€濊€冿紙thought: true + text锛夛細鍙鐨勬€濊€冭繃绋?
     * - 鍔犲瘑鎬濊€冿紙redactedThinking锛夛細涓嶅彲璇伙紝浣嗛渶瑕佸湪鍚庣画瀵硅瘽涓師鏍疯繑鍥?
     *
     * 瀛樺偍鏍煎紡锛?
     * {
     *   "redactedThinking": "EmwKAhgBEgy3va3pzix/LafPsn4a..."
     * }
     *
     * 鍙戦€佹椂闇€瑕佽浆鎹负锛?
     * {
     *   "type": "redacted_thinking",
     *   "data": "EmwKAhgBEgy3va3pzix/LafPsn4a..."
     * }
     */
    redactedThinking?: string;
}

/**
 * Token 璇︽儏鏉＄洰
 *
 * 鎸夋ā鎬侊紙modality锛夊垎绫荤殑 token 缁熻
 */
export interface TokenDetailsEntry {
    /** 妯℃€佺被鍨? "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" */
    modality: string;
    /** Token 鏁伴噺 */
    tokenCount: number;
}

/**
 * Token 浣跨敤缁熻锛圙emini usageMetadata 鏍煎紡锛?
 *
 * 浠呭瓨鍌ㄥ湪 model 瑙掕壊鐨勬秷鎭笂
 */
export interface UsageMetadata {
    /** 杈撳叆 prompt 鐨?token 鏁伴噺 */
    promptTokenCount?: number;
    
    /** 鍊欓€夎緭鍑哄唴瀹圭殑 token 鏁伴噺 */
    candidatesTokenCount?: number;
    
    /** 鎬?token 鏁伴噺锛坧rompt + candidates + thoughts锛?*/
    totalTokenCount?: number;
    
    /** 鎬濊€冮儴鍒嗙殑 token 鏁伴噺 */
    thoughtsTokenCount?: number;
    
    /** Prompt token 璇︽儏锛堟寜妯℃€佸垎绫伙級 */
    promptTokensDetails?: TokenDetailsEntry[];
    
    /** 鍊欓€夎緭鍑?token 璇︽儏锛堟寜妯℃€佸垎绫伙紝濡?IMAGE銆乀EXT 绛夛級 */
    candidatesTokensDetails?: TokenDetailsEntry[];
}

/**
 * Gemini Content锛堟秷鎭唴瀹癸級
 *
 * Gemini API 鐨勬爣鍑嗘秷鎭牸寮?
 */
export interface Content {
    /** 瑙掕壊 */
    role: 'user' | 'model' | 'system';
    /** 鍐呭鐗囨鍒楄〃 */
    parts: ContentPart[];
    
    /**
     * 娑堟伅鍦ㄥ巻鍙茶褰曚腑鐨勭储寮?
     *
     * 鐢卞悗绔湪杩斿洖娑堟伅鏃跺～鍏咃紝鐢ㄤ簬鍓嶇鍦ㄥ垹闄?閲嶈瘯鏃?
     * 鐩存帴浣跨敤姝ょ储寮曪紝鏃犻渶杩涜澶嶆潅鐨勭储寮曡浆鎹㈣绠椼€?
     */
    index?: number;
    
    /**
     * 妯″瀷鐗堟湰锛堜粎 model 娑堟伅鏈夊€硷級
     *
     * 渚嬪: "gemini-2.5-flash", "gpt-5o"
     * 鐢ㄤ簬鏍囪瘑鏄摢涓ā鍨嬬敓鎴愮殑鍥炲
     */
    modelVersion?: string;
    
    /**
     * Token 浣跨敤缁熻锛堜粎 model 娑堟伅鏈夊€硷級
     *
     * 鍖呭惈瀹屾暣鐨?usageMetadata锛?
     * - promptTokenCount: 杈撳叆 prompt 鐨?token 鏁?
     * - candidatesTokenCount: 杈撳嚭鍊欓€夌殑 token 鏁?
     * - totalTokenCount: 鎬?token 鏁?
     * - thoughtsTokenCount: 鎬濊€冮儴鍒嗙殑 token 鏁?
     * - promptTokensDetails: prompt token 璇︽儏
     */
    usageMetadata?: UsageMetadata;
    
    /**
     * 鎬濊€冩寔缁椂闂达紙姣锛?
     *
     * 浠呭鍖呭惈鎬濊€冨唴瀹圭殑 model 娑堟伅鏈夊€?
     * 璁板綍浠庢敹鍒扮涓€涓€濊€冨潡鍒版敹鍒扮涓€涓潪鎬濊€冨唴瀹瑰潡涔嬮棿鐨勬椂闂?
     * 鐢ㄤ簬鍦ㄥ墠绔樉绀?AI 鎬濊€冭€楁椂
     */
    thinkingDuration?: number;
    
    /**
     * 鎬濊€冨紑濮嬫椂闂存埑锛堟绉掞級
     *
     * 浠呭湪娴佸紡鍝嶅簲杩囩▼涓娇鐢紝鐢ㄤ簬璁＄畻鎬濊€冩寔缁椂闂?
     * 瀹屾垚鍚庝細琚Щ闄わ紝鍙繚鐣?thinkingDuration
     */
    thinkingStartTime?: number;
    
    /**
     * 鍝嶅簲鎸佺画鏃堕棿锛堟绉掞級
     *
     * 浠庡彂鍑鸿姹傚埌鍝嶅簲姝ｅ父缁撴潫鐨勬椂闂?
     * 浠呭 model 娑堟伅鏈夊€?
     */
    responseDuration?: number;
    
    /**
     * 绗竴涓祦寮忓潡鏃堕棿鎴筹紙姣锛?
     *
     * 鐢ㄤ簬璁＄畻 Token 閫熺巼
     */
    firstChunkTime?: number;
    
    /**
     * 娴佸紡鍝嶅簲鎸佺画鏃堕棿锛堟绉掞級
     *
     * 浠庢敹鍒扮涓€涓祦寮忓潡鍒板搷搴旂粨鏉熺殑鏃堕棿
     * 鐢ㄤ簬璁＄畻 Token 閫熺巼
     */
    streamDuration?: number;
    
    /**
     * 娴佸紡鍧楁暟閲?
     *
     * 鐢ㄤ簬鍒ゆ柇鏄惁鍙湁涓€涓潡锛堝彧鏈変竴涓潡鏃朵笉璁＄畻閫熺巼锛?
     */
    chunkCount?: number;
    
    /**
     * 鏍囪瘑姝?user 娑堟伅鏄惁涓哄嚱鏁拌皟鐢ㄥ搷搴?
     *
     * 浠呭 role='user' 鐨勬秷鎭湁鎰忎箟
     * - true: 姝ゆ秷鎭寘鍚?functionResponse锛堝嚱鏁版墽琛岀粨鏋滐級
     * - false/undefined: 姝ゆ秷鎭槸鏅€氱敤鎴锋秷鎭?
     *
     * 鐢ㄤ簬鍖哄垎鏅€氱敤鎴锋秷鎭拰鍑芥暟鍝嶅簲娑堟伅锛?
     * 鍦ㄨ繃婊ゆ€濊€冪鍚嶆椂闇€瑕佹鏍囪鏉ュ畾浣嶆渶鍚庝竴涓潪鍑芥暟鍝嶅簲鐨勭敤鎴锋秷鎭?
     */
    isFunctionResponse?: boolean;
    
    /**
     * 鏍囪瘑姝?user 娑堟伅鏄惁涓轰笂涓嬫枃鎬荤粨娑堟伅
     *
     * 浠呭 role='user' 鐨勬秷鎭湁鎰忎箟
     * - true: 姝ゆ秷鎭槸涓婁笅鏂囨€荤粨锛屽寘鍚箣鍓嶅璇濈殑鍘嬬缉鎽樿
     * - false/undefined: 姝ゆ秷鎭槸鏅€氱敤鎴锋秷鎭?
     *
     * 浣跨敤鍦烘櫙锛?
     * - 褰撳璇濊繃闀挎椂锛岀敤鎴峰彲浠ヨЕ鍙戜笂涓嬫枃鎬荤粨
     * - 绯荤粺浼氬皢鏃у璇濆帇缂╀负鎬荤粨娑堟伅
     * - 鍚庣画璋冪敤 AI 鏃讹紝浠庢渶鍚庝竴涓€荤粨娑堟伅寮€濮嬭幏鍙栧巻鍙?
     *
     * 鍓嶇鏄剧ず锛?
     * - 浠ョ壒娈婃牱寮忔樉绀猴紝琛ㄦ槑杩欐槸鎬荤粨鍐呭
     * - 鍙互灞曞紑鏌ョ湅瀹屾暣鎬荤粨
     */
    isSummary?: boolean;
    
    /**
     * 鎬荤粨娑堟伅瑕嗙洊鐨勬秷鎭暟閲?
     *
     * 浠呭綋 isSummary=true 鏃舵湁鎰忎箟
     * 璁板綍姝ゆ€荤粨鏇夸唬浜嗗灏戞潯鍘熷娑堟伅
     */
    summarizedMessageCount?: number;

    /**
     * 鏍囪瘑姝ゆ€荤粨娑堟伅鏄惁鐢辩郴缁熻嚜鍔ㄨЕ鍙?
     *
     * 浠呭綋 isSummary=true 鏃舵湁鎰忎箟
     * - true: 鑷姩鎬荤粨锛堢敱涓婁笅鏂囬槇鍊艰Е鍙戯級
     * - false/undefined: 鎵嬪姩鎬荤粨
     */
    isAutoSummary?: boolean;
    
    /**
     * 鏍囪瘑姝ゆ秷鎭槸鐢ㄦ埛涓诲姩杈撳叆鐨勬秷鎭?
     *
     * 浠呭 role='user' 鐨勬秷鎭湁鎰忎箟
     * - true: 鐢ㄦ埛涓诲姩鍙戦€佺殑娑堟伅锛堝尯鍒簬宸ュ叿鍝嶅簲銆佹€荤粨绛夌郴缁熺敓鎴愮殑 user 娑堟伅锛?
     * - false/undefined: 闈炵敤鎴蜂富鍔ㄨ緭鍏ョ殑娑堟伅
     *
     * 鐢ㄩ€旓細
     * - 纭畾鍔ㄦ€佹彁绀鸿瘝鐨勬彃鍏ヤ綅缃紙鎻掑叆鍒拌繛缁敤鎴疯緭鍏ョ粍涔嬪墠锛?
     * - 鍖哄垎鐢ㄦ埛涓诲姩娑堟伅鍜岀郴缁熸秷鎭?
     */
    isUserInput?: boolean;
    
    /**
     * 娑堟伅鍒涘缓鏃堕棿鎴筹紙姣锛?
     *
     * 鐢ㄤ簬鍓嶇鏄剧ず娑堟伅鍙戦€佹椂闂?
     * 濡傛灉鏈缃紝鍓嶇浼氫娇鐢ㄥ姞杞芥椂鐨勬椂闂?
     */
    timestamp?: number;
    
    /**
     * 璇ユ秷鎭寜娓犻亾鍒嗙被鐨?token 鏁帮紙浠呯敤鎴锋秷鎭拰鍑芥暟鍝嶅簲娑堟伅锛?
     *
     * 鐢变簬涓嶅悓娓犻亾锛圙emini銆丱penAI銆丄nthropic锛夊鍚屼竴娑堟伅鐨?token 璁＄畻鏂瑰紡涓嶅悓锛?
     * 鎸夋笭閬撶被鍨嬪垎鍒瓨鍌紝鍦ㄨ鍓笂涓嬫枃鏃舵牴鎹綋鍓嶄娇鐢ㄧ殑娓犻亾鑾峰彇瀵瑰簲鍊笺€?
     *
     * 璁＄畻鏂瑰紡锛堜紭鍏堢骇浠庨珮鍒颁綆锛夛細
     * 1. 璋冪敤娓犻亾鐨?token 璁℃暟 API 鑾峰彇绮剧‘鍊?
     * 2. 濡傛灉 API 璋冪敤澶辫触锛屼娇鐢ㄧ浉閭昏疆娆?promptTokenCount 宸€艰绠?
     * 3. 濡傛灉娌℃湁 promptTokenCount锛屼娇鐢ㄥ瓧绗︽暟浼扮畻
     *
     * 鐢ㄤ簬锛?
     * - 浼扮畻瀹屾暣鍘嗗彶鐨?token 鏁?
     * - 鍒ゆ柇鏄惁闇€瑕佽鍓笂涓嬫枃
     * - 閬垮厤涓婁笅鏂囨尟鑽￠棶棰?
     *
     * 绀轰緥锛?
     * {
     *   gemini: 1500,
     *   openai: 1520,
     *   anthropic: 1480
     * }
     */
    tokenCountByChannel?: ChannelTokenCounts;
    
    /**
     * @deprecated 浣跨敤 tokenCountByChannel 浠ｆ浛
     * 淇濈暀鐢ㄤ簬鍚戝悗鍏煎锛屾柊浠ｇ爜搴斾娇鐢?tokenCountByChannel
     */
    estimatedTokenCount?: number;
    
    /**
     * @deprecated 浣跨敤 usageMetadata.thoughtsTokenCount 浠ｆ浛
     */
    thoughtsTokenCount?: number;
    
    /**
     * @deprecated 浣跨敤 usageMetadata.candidatesTokenCount 浠ｆ浛
     */
    candidatesTokenCount?: number;
    
    /**
     * 褰撳墠鍥炲悎鐨勫姩鎬佷笂涓嬫枃缂撳瓨锛堜粎瀛樺湪浜庡洖鍚堣捣濮嬬殑 user 娑堟伅涓婏級
     *
     * 鍦ㄥ洖鍚堝紑濮嬫椂锛堢敤鎴峰彂閫佹秷鎭級涓€娆℃€х敓鎴愬姩鎬佷笂涓嬫枃骞跺瓨鍒版瀛楁锛?
     * 鍥炲悎鍐呯殑鎵€鏈夎凯浠ｏ紙鍖呮嫭宸ュ叿纭鍚庣殑缁х画銆侀噸璇曠瓑锛夊鐢ㄦ缂撳瓨锛?
     * 纭繚鍚屼竴鍥炲悎鍐呭姩鎬佷笂涓嬫枃淇濇寔涓€鑷淬€?
     *
     * 浠呭瓨鍌ㄧ函鏂囨湰鍐呭锛岃鍙栨椂閲嶅缓涓?Content[] 鏍煎紡銆?
     *
     * 娉ㄦ剰锛氭瀛楁涓哄悗绔唴閮ㄥ瓧娈碉紝涓嶄細鍙戦€佺粰 AI锛坓etHistoryForAPI 鑷姩杩囨护锛夛紝
     * 涔熶笉浼氫紶缁欏墠绔紙getMessagesPaged 涓繃婊わ級銆?
     */
    turnDynamicContext?: string;
}

/**
 * 瀵硅瘽鍘嗗彶锛圙emini 鏍煎紡锛?
 * 
 * 杩欐槸瀛樺偍鐨勬牳蹇冩牸寮?
 * - 鐩存帴鍏煎 Gemini API
 * - 鍖呭惈鎵€鏈夐珮绾х壒鎬?鍑芥暟璋冪敤銆佹€濊€冪鍚嶃€佹€濊€冨唴瀹圭瓑)
 * - 鍙互鐩存帴鍙戦€佺粰 Gemini API
 * 
 * 瀛樺偍鏂瑰紡:
 * - 鏂囦欢鍚? {conversationId}.json
 * - 鍐呭: JSON.stringify(ConversationHistory)
 * 
 * 鎬濊€冨唴瀹瑰瓨鍌?
 * - 鎬濊€冩憳瑕佷細琚爣璁颁负 thought: true
 * - 鎬濊€冪鍚嶄細鑷姩淇濆瓨鍦?thoughtSignatures 瀛楁
 * - 鍙€夋嫨鏄惁鍦?UI 涓樉绀烘€濊€冨唴瀹?
 */
export type ConversationHistory = Content[];

/**
 * 妫€鏌ョ偣璁板綍
 *
 * 涓庡璇濇秷鎭储寮曞叧鑱旂殑浠ｇ爜搴撳揩鐓ц褰?
 */
export interface CheckpointRecord {
    /** 妫€鏌ョ偣鍞竴 ID */
    id: string;
    
    /**
     * 鍏宠仈鐨勬秷鎭储寮?
     *
     * 琛ㄧず姝ゆ鏌ョ偣鏄湪澶勭悊璇ョ储寮曟秷鎭椂鍒涘缓鐨?
     * 瀵逛簬 before 闃舵锛氬湪鎵ц宸ュ叿鍓嶅垱寤猴紝鍏宠仈宸ュ叿璋冪敤娑堟伅
     * 瀵逛簬 after 闃舵锛氬湪鎵ц宸ュ叿鍚庡垱寤猴紝鍏宠仈宸ュ叿鍝嶅簲娑堟伅
     */
    messageIndex: number;
    
    /** 瑙﹀彂澶囦唤鐨勫伐鍏峰悕绉?*/
    toolName: string;
    
    /**
     * 澶囦唤闃舵
     * - before: 宸ュ叿鎵ц鍓?
     * - after: 宸ュ叿鎵ц鍚?
     */
    phase: 'before' | 'after';
    
    /** 鍒涘缓鏃堕棿鎴?*/
    timestamp: number;
    
    /** 鎻忚堪淇℃伅 */
    description?: string;
    
    /** 缁熻淇℃伅 */
    stats: {
        /** 鏂囦欢鏁伴噺 */
        fileCount: number;
        /** 鎬诲ぇ灏忥紙瀛楄妭锛?*/
        totalSize: number;
    };
}

/**
 * 瀵硅瘽鍏冩暟鎹?
 *
 * 瀛樺偍瀵硅瘽鐨勯澶栦俊鎭?涓嶆槸 Gemini 鏍煎紡鐨勪竴閮ㄥ垎)
 */
export interface ConversationMetadata {
    /** 瀵硅瘽 ID */
    id: string;
    /** 瀵硅瘽鏍囬 */
    title?: string;
    /** 鍒涘缓鏃堕棿 */
    createdAt: number;
    /** 鏈€鍚庢洿鏂版椂闂?*/
    updatedAt: number;
    
    /**
     * 宸ヤ綔鍖?URI
     *
     * 鍒涘缓瀵硅瘽鏃剁殑宸ヤ綔鍖鸿矾寰勶紝鐢ㄤ簬绛涢€夋樉绀?
     * 渚嬪: "file:///c%3A/Users/xxx/projects/my-project"
     */
    workspaceUri?: string;
    
    /**
     * 妫€鏌ョ偣鍒楄〃
     *
     * 涓庢秷鎭储寮曞叧鑱旂殑浠ｇ爜搴撳揩鐓ц褰?
     */
    checkpoints?: CheckpointRecord[];
    
    /** 鑷畾涔夊厓鏁版嵁 */
    custom?: Record<string, unknown>;

    /**
     * Storage integrity status (optional)
     *
     * - ok: history and metadata are readable
     * - meta_missing: history exists but metadata file is missing
     * - meta_corrupt: metadata exists but cannot be parsed
     * - history_missing: metadata exists but history file is missing
     * - history_corrupt: history exists but cannot be parsed
     */
    integrityStatus?: 'ok' | 'meta_missing' | 'meta_corrupt' | 'history_missing' | 'history_corrupt';
}

/**
 * 瀹屾暣鐨勫璇濇暟鎹?鍖呭惈鍘嗗彶鍜屽厓鏁版嵁)
 */
export interface ConversationData {
    /** 瀵硅瘽鍏冩暟鎹?*/
    metadata: ConversationMetadata;
    /** 瀵硅瘽鍘嗗彶(Gemini 鏍煎紡) */
    history: ConversationHistory;
}

/**
 * 娑堟伅浣嶇疆瀹氫綅
 */
export interface MessagePosition {
    /** 娑堟伅绱㈠紩 */
    index: number;
    /** 瑙掕壊 */
    role: 'user' | 'model' | 'system';
}

/**
 * 娑堟伅杩囨护鍣?
 */
export interface MessageFilter {
    /** 鎸夎鑹茶繃婊?*/
    role?: 'user' | 'model' | 'system';
    /** 鎸夋槸鍚﹀寘鍚嚱鏁拌皟鐢ㄨ繃婊?*/
    hasFunctionCall?: boolean;
    /** 鎸夋槸鍚﹀寘鍚枃鏈繃婊?*/
    hasText?: boolean;
    /** 鎸夋槸鍚︿负鎬濊€冨唴瀹硅繃婊?*/
    isThought?: boolean;
    /** 鎸夌储寮曡寖鍥磋繃婊?*/
    indexRange?: {
        start: number;
        end: number;
    };
}

/**
 * 鍘嗗彶蹇収
 * 
 * 鐢ㄤ簬淇濆瓨瀵硅瘽鐨勬煇涓椂闂寸偣鐘舵€?
 */
export interface HistorySnapshot {
    /** 蹇収 ID */
    id: string;
    /** 瀵硅瘽 ID */
    conversationId: string;
    /** 蹇収鍚嶇О */
    name?: string;
    /** 蹇収鎻忚堪 */
    description?: string;
    /** 蹇収鏃堕棿鎴?*/
    timestamp: number;
    /** 鍘嗗彶璁板綍(Gemini 鏍煎紡) */
    history: ConversationHistory;
}

/**
 * 瀵硅瘽缁熻淇℃伅
 */
export interface ConversationStats {
    /** 鎬绘秷鎭暟 */
    totalMessages: number;
    /** 鐢ㄦ埛娑堟伅鏁?*/
    userMessages: number;
    /** 妯″瀷娑堟伅鏁?*/
    modelMessages: number;
    /** 鍑芥暟璋冪敤娆℃暟 */
    functionCalls: number;
    /** 鏄惁鍖呭惈鎬濊€冪鍚?*/
    hasThoughtSignatures: boolean;
    /** 鏄惁鍖呭惈鎬濊€冨唴瀹?*/
    hasThoughts: boolean;
    /** 鏄惁鍖呭惈鏂囦欢鏁版嵁 */
    hasFileData: boolean;
    /** 鏄惁鍖呭惈鍐呭祵澶氭ā鎬佹暟鎹?*/
    hasInlineData: boolean;
    /** 鍐呭祵鏁版嵁鎬诲ぇ灏忥紙瀛楄妭锛?*/
    inlineDataSize: number;
    /** 澶氭ā鎬佸唴瀹圭粺璁?*/
    multimedia: {
        images: number;
        audio: number;
        video: number;
        documents: number;
    };
    /** Token 缁熻 */
    tokens: {
        /** 鎬绘€濊€?token 鏁?*/
        totalThoughtsTokens: number;
        /** 鎬诲€欓€夎緭鍑?token 鏁?*/
        totalCandidatesTokens: number;
        /** 鎬?token 鏁帮紙鎬濊€?+ 杈撳嚭锛?*/
        totalTokens: number;
        /** 鏈夋€濊€?token 璁板綍鐨勬秷鎭暟 */
        messagesWithThoughtsTokens: number;
        /** 鏈夊€欓€?token 璁板綍鐨勬秷鎭暟 */
        messagesWithCandidatesTokens: number;
    };
}

/**
 * 娑堟伅缂栬緫鎿嶄綔
 */
export interface MessageEdit {
    /** 娑堟伅绱㈠紩 */
    index: number;
    /** 鏂扮殑鏂囨湰鍐呭 */
    newText: string;
}

/**
 * 娑堟伅鎻掑叆鎿嶄綔
 */
export interface MessageInsert {
    /** 鎻掑叆浣嶇疆锛堝湪姝ょ储寮曚箣鍓嶆彃鍏ワ級 */
    beforeIndex: number;
    /** 瑕佹彃鍏ョ殑娑堟伅 */
    content: Content;
}
