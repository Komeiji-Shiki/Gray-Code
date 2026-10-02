import * as fs from 'fs/promises';
import * as iconv from 'iconv-lite';
import type { SearchFileHost, FileLocation } from './fileHost';
/** 自动检测只产生前三种与常见的东亚编码；显式指定时还可用 iconv-lite 支持的其他编码（如 euc-kr）。 */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'gb18030' | 'shift_jis' | 'big5' | 'windows-1252' | (string & {});
export interface TextDetectionResult {
    isText: boolean;
    encoding: TextEncoding;
    /** BOM 字节数（需要跳过） */
    bomLength: number;
    reason?: string;
    /** 来源：BOM、UTF-8 校验、内容推测或调用方指定。旧记录没有此字段。 */
    source?: 'bom' | 'utf8' | 'guess' | 'explicit' | 'utf16-heuristic';
}
export function detectTextFromHeader(header: Uint8Array): TextDetectionResult {
    if (!header || header.length === 0) {
        return { isText: true, encoding: 'utf-8', bomLength: 0 };
    }

    // BOM 检测
    if (header.length >= 3 && header[0] === 0xEF && header[1] === 0xBB && header[2] === 0xBF) {
        return { isText: true, encoding: 'utf-8', bomLength: 3 };
    }
    if (header.length >= 2 && header[0] === 0xFF && header[1] === 0xFE) {
        return { isText: true, encoding: 'utf-16le', bomLength: 2 };
    }
    if (header.length >= 2 && header[0] === 0xFE && header[1] === 0xFF) {
        return { isText: true, encoding: 'utf-16be', bomLength: 2 };
    }

    // UTF-16（无 BOM）启发式：大量 NUL 且集中在偶/奇位
    const sampleLen = Math.min(header.length, 1024);
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            if (i % 2 === 0) evenZeros++;
            else oddZeros++;
        }
    }
    const evenCount = Math.ceil(sampleLen / 2);
    const oddCount = Math.floor(sampleLen / 2) || 1;
    const evenZeroRatio = evenZeros / (evenCount || 1);
    const oddZeroRatio = oddZeros / oddCount;

    if (oddZeroRatio > 0.3 && evenZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16le', bomLength: 0 };
    }
    if (evenZeroRatio > 0.3 && oddZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16be', bomLength: 0 };
    }

    // NUL 基本可判为二进制（非 UTF-16）
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            return { isText: false, encoding: 'utf-8', bomLength: 0, reason: 'NUL byte detected' };
        }
    }

    // 控制字符占比过高：倾向二进制
    let suspicious = 0;
    for (let i = 0; i < sampleLen; i++) {
        const b = header[i];
        const isAllowedWhitespace = b === 0x09 || b === 0x0A || b === 0x0D; // \t \n \r
        const isControl =
            (b < 0x20 && !isAllowedWhitespace) ||
            b === 0x7F;
        if (isControl) suspicious++;
    }
    const suspiciousRatio = suspicious / (sampleLen || 1);
    if (suspiciousRatio > 0.3) {
        return { isText: false, encoding: 'utf-8', bomLength: 0, reason: `High control-char ratio: ${suspiciousRatio.toFixed(2)}` };
    }

    return { isText: true, encoding: 'utf-8', bomLength: 0 };
}
function swapByteOrder16(data: Uint8Array): Uint8Array {
    const len = data.length - (data.length % 2);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 2) {
        out[i] = data[i + 1];
        out[i + 1] = data[i];
    }
    return out;
}
export function decodeTextBytes(bytes: Uint8Array, detection: TextDetectionResult): string {
    const start = Math.max(0, detection.bomLength || 0);
    const sliced = bytes.subarray(start);

    if (detection.encoding === 'utf-16be') {
        const swapped = swapByteOrder16(sliced);
        return new TextDecoder('utf-16le').decode(swapped);
    }

    if (detection.encoding === 'utf-16le') {
        return new TextDecoder('utf-16le').decode(sliced);
    }

    if (detection.encoding !== 'utf-8') return iconv.decode(Buffer.from(sliced.buffer, sliced.byteOffset, sliced.byteLength), detection.encoding);
    return new TextDecoder('utf-8').decode(sliced);
}
/** 替换后保留原编码与 BOM，避免把 UTF-16、GBK 等文件静默改写成 UTF-8。无法用原编码表示的字符直接报错。 */
export function encodeTextBytes(text: string, detection: TextDetectionResult): Uint8Array {
    if (isLegacyEncoding(detection.encoding)) {
        const unsupported = findUnencodableCharacter(text, detection.encoding);
        if (unsupported) throw new Error(`ENCODING_UNREPRESENTABLE: 第 ${unsupported.line} 行的字符 "${unsupported.character}" 无法用 ${detection.encoding} 编码写回，已取消写入，文件保持原样。`);
        return iconv.encode(text, detection.encoding);
    }
    const bytes = Buffer.from(text, detection.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (detection.encoding === 'utf-16be') bytes.swap16();
    if (!detection.bomLength) return bytes;
    const bom = detection.encoding === 'utf-8' ? [0xef, 0xbb, 0xbf]
        : detection.encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    return Buffer.concat([Buffer.from(bom), bytes]);
}

const UNICODE_ENCODINGS = new Set(['utf-8', 'utf-16le', 'utf-16be']);
export function isLegacyEncoding(encoding: string): boolean { return !UNICODE_ENCODINGS.has(encoding); }

/** 模型或用户常写的别名映射到统一名称；不支持的编码直接报错，不静默回退。 */
export function normalizeTextEncodingName(value: string): TextEncoding {
    const name = value.trim().toLowerCase().replace(/_/g, '-');
    const alias: Record<string, TextEncoding> = {
        'utf8': 'utf-8', 'utf-8': 'utf-8', 'utf-8-bom': 'utf-8', 'utf8bom': 'utf-8', 'utf-16': 'utf-16le', 'utf16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf16le': 'utf-16le',
        'utf-16be': 'utf-16be', 'utf16be': 'utf-16be', 'gbk': 'gbk', 'gb2312': 'gbk', 'cp936': 'gbk', 'gb18030': 'gb18030',
        'shift-jis': 'shift_jis', 'shiftjis': 'shift_jis', 'sjis': 'shift_jis', 'cp932': 'shift_jis', 'windows-31j': 'shift_jis', 'big5': 'big5', 'cp950': 'big5',
        // Latin-1 的 0x80–0x9F 是控制字符，不能按 Windows-1252 的标点与货币符号解码。
        'latin1': 'iso-8859-1', 'iso-8859-1': 'iso-8859-1', 'cp1252': 'windows-1252', 'windows-1252': 'windows-1252',
    };
    const resolved = alias[name] ?? name;
    if (!UNICODE_ENCODINGS.has(resolved) && !iconv.encodingExists(resolved)) throw new Error(`不支持的编码：${value}。可用 utf-8、utf-16le、utf-16be、gbk、gb18030、shift_jis、big5、euc-kr、windows-1252 等。`);
    return resolved;
}

/**
 * 完整内容的编码检测：BOM 与 UTF-16 启发式优先，其次严格校验 UTF-8，最后在 GBK/GB18030、Shift-JIS、Big5 之间按解码结果的
 * 合理程度选择，都不可信时按 Windows-1252 解码。只用文件头时（搜索预检）请用 detectTextFromHeader。
 * encoding 显式指定时仍识别并跳过 BOM，但不再推测。
 */
export function detectTextEncoding(bytes: Uint8Array, encoding?: string): TextDetectionResult {
    const header = detectTextFromHeader(bytes.subarray(0, 4096));
    if (encoding) {
        const requested = normalizeTextEncodingName(encoding);
        const bomLength = header.bomLength && header.encoding === requested ? header.bomLength : 0;
        return { isText: true, encoding: requested, bomLength, source: 'explicit' };
    }
    if (header.bomLength) return { ...header, source: 'bom' };
    // 无 BOM 的 UTF-16 只在样本足够时采信；几个字节里的 NUL 更可能是二进制
    if (header.encoding !== 'utf-8' && bytes.length >= 16) return { ...header, source: 'utf16-heuristic' };
    // 文件头之后仍可能出现 NUL；二进制判定以完整内容为准
    if (!header.isText || bytes.includes(0)) return { isText: false, encoding: 'utf-8', bomLength: 0, reason: header.reason ?? 'NUL byte detected' };
    if (isUtf8(bytes)) return { isText: true, encoding: 'utf-8', bomLength: 0, source: 'utf8' };
    return { isText: true, encoding: guessLegacyEncoding(bytes), bomLength: 0, source: 'guess' };
}

function isUtf8(bytes: Uint8Array): boolean {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/**
 * 常用汉字（简繁与日文常用字混合）。错误编码解出的汉字接近随机，落在这个集合里的比例明显低于正确解码，
 * 用来区分 GBK 与 Big5 这类字节范围重叠的编码。
 */
const COMMON_HAN = new Set(Array.from(
    '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吧各求远组来文件页设置配系统程序数据错误失败路径目录字符串函输入输出选择执行启动运行游戏界面加载保存返回执移删除添创按钮窗口编写代码注释变量值类型模块式条件判断测试版本更新下载安装网络连接服务器客户端用户密码登录信息显示消息状态结束开始完成成功默认参数功能支持打开关闭查找修改复制处理内容项目请求响应语言中文英日本韩' +
    '個們為來說時對後麼發會當見經頭面從動兩長民樣現與進實回理點種聲話兒問機給業間打便位因重被開電門相次東政使教聽世氣信少關並內加化由卻代軍產入萬市眼體別處總才場師書員笑性通目華報立馬命張活難神數件安表原車白應路期叫死常提感金何更反合放做系計或司利受光王果親界及今京務制解各任至清物臺象記邊共風戰幹接許覺望直服毛林題建南度統色字請交愛讓認算論百求遠組檔頁設置設定配系統程式序資料錯誤失敗路徑目錄輸入輸出選擇執行啟動運行遊戲介面載入儲存傳回移刪除新增按鈕視窗編寫程式碼註解變數類型模組條件判斷測試版本更新下載安裝網路連接伺服器用戶密碼登入訊息顯示狀態結束開始完成預設參數功能支援關閉尋找修改複製處理內容專案請求回應語言' +
    '日本語私事会社時間自分今日大丈夫気持続機能設定画面表示実行選択終了開始起動保存削除変更追加入力出力読込書込検索文字列引数関数変数型配列'
));

/** 解码结果的合理程度：常用汉字与（仅 Shift-JIS 下的）假名加分，生僻字、半角片假名和私用区扣分。 */
function plausibility(text: string, encoding: string): number {
    let score = 0, count = 0;
    for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code < 0x80) continue;
        count++;
        if (COMMON_HAN.has(character)) score += 1;
        else if (code >= 0x3040 && code <= 0x30ff) score += encoding === 'shift_jis' ? 1 : 0.1;
        else if (code >= 0x3000 && code <= 0x303f || code >= 0xff01 && code <= 0xff5e || code >= 0x2010 && code <= 0x2027) score += 0.5;
        else if (code >= 0x4e00 && code <= 0x9fff) score += 0.15;
        // 补充平面（表情、扩展汉字）只有 GB18030 的四字节序列能解出，其他东亚编码不会产生
        else if (code > 0xffff) score += encoding === 'gbk' ? 1 : -1;
        else if (code >= 0xff61 && code <= 0xff9f) score -= encoding === 'shift_jis' ? 0.2 : 0.5;
        else if (code >= 0xe000 && code <= 0xf8ff || code === 0xfffd) score -= 1;
        else score -= 0.2;
    }
    return count ? score / count : 0;
}

function guessLegacyEncoding(bytes: Uint8Array): TextEncoding {
    let best: { encoding: TextEncoding; score: number } | undefined;
    // TextDecoder 的 GBK 实现也可能接受 GB18030 四字节序列，须确认实际写回编码能还原字节后再优先选 GBK。
    for (const encoding of ['gbk', 'gb18030', 'shift_jis', 'big5'] as const) {
        if (encoding === 'gb18030' && best?.encoding === 'gbk') continue;
        let text: string;
        try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { continue; }
        if (encoding === 'gbk' && !iconv.encode(text, encoding).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) continue;
        const score = plausibility(text, encoding === 'gb18030' ? 'gbk' : encoding);
        if (!best || score > best.score) best = { encoding, score };
    }
    if (!best || best.score < 0.3) return 'windows-1252';
    return best.encoding;
}

/** 旧编码写回前的检查：返回第一个无法用该编码表示的字符及其行号。 */
export function findUnencodableCharacter(text: string, encoding: string): { character: string; line: number } | undefined {
    if (!isLegacyEncoding(encoding)) return undefined;
    if (iconv.decode(iconv.encode(text, encoding), encoding) === text) return undefined;
    let line = 1;
    for (const character of text) {
        if (character === '\n') { line++; continue; }
        if (character.charCodeAt(0) < 0x80) continue;
        if (iconv.decode(iconv.encode(character, encoding), encoding) !== character) return { character, line };
    }
    return { character: '?', line };
}

/** 按检测到的编码解码后再编码，字节完全一致才允许编辑，避免推测错误时写坏文件。 */
export function roundTripsExactly(bytes: Uint8Array, detection: TextDetectionResult): boolean {
    try {
        const encoded = encodeTextBytes(decodeTextBytes(bytes, detection), detection);
        const original = bytes.subarray(isLegacyEncoding(detection.encoding) ? detection.bomLength : 0);
        return Buffer.compare(Buffer.from(encoded), Buffer.from(original.buffer, original.byteOffset, original.byteLength)) === 0;
    } catch { return false; }
}
export function createTextReader(host: SearchFileHost) {
async function tryGetFileSizeBytes(uri: FileLocation): Promise<number | undefined> {
    try {
        const stat = await host.stat(uri);
        return typeof stat.size === 'number' ? stat.size : undefined;
    } catch {
        return undefined;
    }
}
async function readHeaderBytes(uri: FileLocation, maxBytes: number): Promise<Uint8Array> {
    if (host.readHeader) return host.readHeader(uri, maxBytes);
    const n = Math.max(0, Math.floor(maxBytes));
    if (n <= 0) {
        return new Uint8Array();
    }

    // 本地文件优先用 Node fs 做真正的“只读文件头”
    if (uri.scheme === 'file' && uri.fsPath) {
        try {
            const handle = await fs.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(n);
                const { bytesRead } = await handle.read(buffer, 0, n, 0);
                return buffer.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        } catch {
            // 回退到 vscode fs
        }
    }

    // 非 file scheme：无法保证部分读取，退化为读取后截取（有大小护栏即可）
    const content = await host.readFile(uri);
    return content.subarray(0, Math.min(n, content.length));
}
return { tryGetFileSizeBytes,readHeaderBytes };
}
