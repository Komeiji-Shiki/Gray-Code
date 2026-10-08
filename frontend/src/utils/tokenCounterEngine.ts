import { Tiktoken } from 'js-tiktoken/lite'

export type TokenizerKind = 'gpt' | 'deepseek'
export interface TokenizerResource {
  name: string
  bpeRanks: string
  patStr: string
  specialTokens: Record<string, number>
}
export type TokenizerRequest = { id: number; kind: TokenizerKind } & (
  | { type: 'load'; resource: TokenizerResource }
  | { type: 'count'; texts: string[] }
)
export interface TokenizerResponse {
  id: number
  counts?: number[]
  error?: string
}

/** 只由工作线程持有词表和编码缓存，界面线程不构造 Tiktoken。 */
export class TokenCounterEngine {
  private readonly encoders = new Map<TokenizerKind, Tiktoken>()

  handle(request: TokenizerRequest): TokenizerResponse {
    try {
      if (request.type === 'load') {
        const resource = request.resource
        this.encoders.set(request.kind, new Tiktoken({
          bpe_ranks: resource.bpeRanks,
          pat_str: resource.patStr,
          special_tokens: resource.specialTokens
        }))
        return { id: request.id }
      }
      const encoder = this.encoders.get(request.kind)
      if (!encoder) throw new Error('分词词表尚未就绪')
      return { id: request.id, counts: request.texts.map(text => {
        let count = 0
        // 沿用原有 2000 字符分片，保留跨片合并缺失造成的既有估算误差。
        for (let index = 0; index < text.length; index += 2000) {
          count += encoder.encode(text.slice(index, index + 2000)).length
        }
        return count
      }) }
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
