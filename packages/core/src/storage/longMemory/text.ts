import { createHash } from 'node:crypto';
import { countTextTokens, type TokenizerOptions } from '../../tokenizer';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stop = new Set(['我', '的', '了', '是', '吗', '什么', '怎么', '哪个', '哪种', '现在', '目前', '这个', '那个', '之前', '告诉', '自己', '多少', '时候', '怎样', '一下', '可以', '有没有', '已经', '真的', '真实', '实际', '当前', '当时', '我们', '只', '用', '按', '在', '和', '与', '会', '不', '有', '这', '那', '就', '都', '还', '把', '给', '到', '从', '上', '中', '呢']);

/** 分词与检索共用中文规范化，不用哈希向量冒充语义模型。 */
export function memoryTerms(text: string): string[] {
  const result: string[] = [];
  for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike || stop.has(part.segment)) continue;
    result.push(part.segment);
    if (/^\p{Script=Han}{3,}$/u.test(part.segment)) {
      const chars = [...part.segment];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars.slice(i, i + 2).join(''));
    }
  }
  return result;
}
export const memoryDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 记忆预算统一使用本地 tokenizer；无模型词表时采用明确的通用基准。 */
export function memoryTokens(text: string, options?: TokenizerOptions): number {
  return countTextTokens(text, options);
}
export const memoryTopicKey = (topic: string[]): string => JSON.stringify(topic);
