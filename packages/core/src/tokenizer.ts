import type { Tiktoken, TiktokenModel } from 'tiktoken';

export interface TokenizerOptions {
  model?: string;
  channelType?: string;
  imageDetail?: 'low' | 'high' | 'original' | 'auto';
  mediaResolution?: 'low' | 'medium' | 'high' | 'ultra_high';
}

export interface TextTokenizerDescription {
  encoding: 'cl100k_base' | 'o200k_base';
  source: 'model-tokenizer' | 'generic-tokenizer';
  model?: string;
}

const descriptions = new Map<string, TextTokenizerDescription>();
const encoders = new Map<TextTokenizerDescription['encoding'], Tiktoken>();
const textCounts = new Map<string, number>();
const jsonCounts = new WeakMap<object, Map<TextTokenizerDescription['encoding'], number>>();
let cachedTextCharacters = 0;
let tokenizerRuntime: typeof import('tiktoken') | undefined;

/** Rust/WASM 整段 BPE 避免连续中文在纯 JS 实现中阻塞；整个进程只加载一次运行时。 */
function runtime(): typeof import('tiktoken') {
  return tokenizerRuntime ??= require('tiktoken') as typeof import('tiktoken');
}

/** 只对词表包明确识别的模型声明匹配；其余模型统一标注 o200k 通用基准。 */
export function describeTextTokenizer(options: TokenizerOptions = {}): TextTokenizerDescription {
  const model = options.model?.trim();
  const cached = descriptions.get(model ?? '');
  if (cached) return cached;
  if (model) {
    try {
      const encoding = runtime().get_encoding_name_for_model(model as TiktokenModel);
      if (encoding === 'cl100k_base' || encoding === 'o200k_base') {
        const description: TextTokenizerDescription = { encoding, source: 'model-tokenizer', model };
        descriptions.set(model, description);
        return description;
      }
    } catch {
      // 自定义模型名与未公开词表的供应方无法据名称推出真实分词规则。
    }
  }
  const description: TextTokenizerDescription = { encoding: 'o200k_base', source: 'generic-tokenizer', model };
  descriptions.set(model ?? '', description);
  return description;
}

/** 首次实际计数才构造词表；特殊 token 外观按用户原文编码，不能当控制标记吞掉。 */
export function countTextTokens(text: string, options: TokenizerOptions = {}): number {
  if (!text) return 0;
  const { encoding } = describeTextTokenizer(options);
  const key = `${encoding}:${text}`;
  const cached = textCounts.get(key);
  if (cached !== undefined) return cached;
  let encoder = encoders.get(encoding);
  if (!encoder) {
    encoder = runtime().get_encoding(encoding);
    encoders.set(encoding, encoder);
  }
  const tokens = encoder.encode(text, [], []).length;
  // 原始长正文由对象弱缓存负责；字符串缓存仅覆盖跨快照复用的前缀，避免长期持有整个会话。
  if (text.length <= 131_072) {
    while (textCounts.size >= 128 || cachedTextCharacters + key.length > 1_048_576) {
      const oldest = textCounts.keys().next().value!;
      cachedTextCharacters -= oldest.length;
      textCounts.delete(oldest);
    }
    textCounts.set(key, tokens);
    cachedTextCharacters += key.length;
  }
  return tokens;
}

/** 对稳定的工具定义/参数正文只序列化一次；修改内容时调用方须替换正文对象。 */
export function countJsonTokens(value: unknown, options: TokenizerOptions = {}): number {
  if (!value || typeof value !== 'object') return countTextTokens(JSON.stringify(value) ?? '', options);
  const { encoding } = describeTextTokenizer(options);
  let counts = jsonCounts.get(value);
  const cached = counts?.get(encoding);
  if (cached !== undefined) return cached;
  const count = countTextTokens(JSON.stringify(value), options);
  if (!counts) { counts = new Map(); jsonCounts.set(value, counts); }
  counts.set(encoding, count);
  return count;
}
