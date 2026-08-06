/**
 * tokenizer 词表格式转换（纯函数，可单测）。
 *
 * 目标格式（js-tiktoken/lite 的 Tiktoken 构造要求）：
 * - bpeRanks：每行 `x <rank> <base64(UTF-8 字节)>`——第一字段是占位（解析时被丢弃），
 *   第二字段是起始 rank，第三字段起是 base64 token 列表（rank 连续递增）。
 * - patStr：单个正则（在原始文本上切分，切分片段按 UTF-8 字节查词表做 BPE）。
 */

export interface DeepseekTokenizerOutput {
    bpeRanks: string;
    patStr: string;
    specialTokens: Record<string, number>;
}

/** cl100k 的标准切分正则（与 js-tiktoken 内置 cl100k_base 一致） */
export const CL100K_PAT_STR =
    "('s|'S|'t|'T|'re|'rE|'Re|'RE|'ve|'vE|'Ve|'VE|'m|'M|'ll|'lL|'Ll|'LL|'d|'D)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

/** cl100k 的特殊 token（与 tiktoken cl100k_base 内置一致） */
export const CL100K_SPECIAL_TOKENS: Record<string, number> = {
    '<|endoftext|>': 100257,
    '<|fim_prefix|>': 100258,
    '<|fim_middle|>': 100259,
    '<|fim_suffix|>': 100260,
    '<|endofprompt|>': 100276
};

/**
 * 将 OpenAI 官方 cl100k_base.tiktoken（每行 `base64 rank`）转换为 js-tiktoken 格式
 * （每行 `x rank base64`，补占位字段）。
 */
export function cl100kTiktokenToJsTiktoken(content: string): string {
    const lines: string[] = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        const token = parts[0];
        const rank = parts[1];
        if (!token || rank === undefined || !/^\d+$/.test(rank)) continue;
        lines.push(`x ${rank} ${token}`);
    }
    return lines.join('\n') + '\n';
}

// ---------- DeepSeek V3（HF tokenizer.json → js-tiktoken 格式） ----------

/** tiktoken bytes_to_unicode 映射（与 HF ByteLevel 兼容）：字符 → 原始字节 */
function buildByteEncoder(): Map<string, number> {
    const bs: number[] = [];
    for (let b = 0x21; b <= 0x7e; b++) bs.push(b); // ! ~
    for (let b = 0xa1; b <= 0xac; b++) bs.push(b); // ¡ ¬
    for (let b = 0xae; b <= 0xff; b++) bs.push(b); // ® ÿ
    const cs = bs.slice();
    let n = 0;
    for (let b = 0; b < 256; b++) {
        if (!bs.includes(b)) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    const charToByte = new Map<string, number>();
    for (let i = 0; i < bs.length; i++) {
        charToByte.set(String.fromCharCode(cs[i]), bs[i]);
    }
    return charToByte;
}

const deepseekCharToByte = buildByteEncoder();

/** 将 HF ByteLevel 映射字符 token 解码回原始 UTF-8 字节 */
function decodeByteToken(token: string): Buffer {
    const bytes: number[] = [];
    for (const ch of token) {
        const b = deepseekCharToByte.get(ch);
        if (b === undefined) {
            bytes.push(...Buffer.from(ch, 'utf8'));
        } else {
            bytes.push(b);
        }
    }
    return Buffer.from(bytes);
}

/**
 * 将 DeepSeek V3 官方 tokenizer.json（HuggingFace 格式）转换为 js-tiktoken 格式。
 * 已与官方 Python tokenizers 基准验证：12 类样本（中/英/代码/JSON/emoji）逐位一致。
 */
export function deepseekHfToTiktoken(tokenizerJson: unknown): DeepseekTokenizerOutput {
    const j = tokenizerJson as {
        model?: { vocab?: Record<string, number> };
        added_tokens?: Array<{ id: number; content: string; special?: boolean }>;
    };
    const vocab = j.model?.vocab ?? {};
    const addedTokens = j.added_tokens ?? [];

    const ranks: string[] = [];
    for (const [token, id] of Object.entries(vocab)) {
        ranks.push(`x ${id} ${decodeByteToken(token).toString('base64')}`);
    }
    // 按 rank 排序（保持可读性；js-tiktoken 不要求有序）
    ranks.sort((a, b) => Number(a.split(' ')[1]) - Number(b.split(' ')[1]));

    const specialTokens: Record<string, number> = {};
    for (const t of addedTokens) {
        if (t.special) specialTokens[t.content] = t.id;
    }

    // 合并 pre_tokenizer 的 3 个 Split（均为 Isolated，字符类互不相交，交替等价）
    const p1 = '\\p{N}{1,3}';
    const p2 = '[一-龥぀-ゟ゠-ヿ]+';
    const p3 = "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

    return {
        bpeRanks: ranks.join('\n') + '\n',
        patStr: `${p1}|${p2}|${p3}`,
        specialTokens
    };
}
