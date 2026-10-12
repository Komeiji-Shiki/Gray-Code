import { createHash } from 'node:crypto';
import type { WorldbookDefinition } from '@graycode/contracts';
import { expandCharacterMacros, VectorMatrixCache, VectorRanker, vectorMatrixBytes } from '@graycode/core';
import type { PlatformApplication } from '../application';

interface VectorWorldInput {
  actorId: string;
  books: WorldbookDefinition[];
  history: string[];
  scanDepth: number;
  macros: Record<string, string>;
  texts: Record<string, string>;
  additionalSources: Record<string, string>;
  preview?: boolean;
}
interface VectorGroup {
  query: string;
  entries: Array<{ key: string; text: string }>;
}

/** 使用记忆已有的嵌入配置与向量计算线程，不把虚构世界书写入真实记忆库。 */
export class WorldbookVectors {
  private ranker?: VectorRanker;
  private readonly matrices = new VectorMatrixCache(16 * 1024 * 1024);
  private readonly dimensions = new Map<string, number>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: PlatformApplication) {}

  activate(input: VectorWorldInput, signal?: AbortSignal): Promise<{ matches?: Record<string, number>; error?: string }> {
    const operation = this.pending.then(() => this.evaluate(input, signal));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async evaluate(input: VectorWorldInput, signal?: AbortSignal): Promise<{ matches?: Record<string, number>; error?: string }> {
    signal?.throwIfAborted();
    const groups = new Map<string, VectorGroup>();
    for (const book of input.books) for (const entry of book.entries) {
      if (!entry.vectorized || entry.constant || !entry.enabled || !entry.content.trim()) continue;
      const entryKey = `${book.id}/${entry.id}`;
      const text = input.texts[entryKey] ?? expandCharacterMacros(entry.content, input.macros);
      if (!text.trim()) continue;
      const depth = Math.max(0, Math.floor(entry.scanDepth ?? book.scanDepth ?? input.scanDepth));
      const extra = (entry.additionalSources ?? []).map(name => input.additionalSources[name] ?? '').join('\n');
      const key = JSON.stringify([depth, extra]);
      let group = groups.get(key);
      if (!group) {
        const history = depth === 0 ? '' : input.history.slice(-depth).join('\n');
        group = { query: expandCharacterMacros(`${history}\n${extra}`, input.macros).trim(), entries: [] };
        groups.set(key, group);
      }
      group.entries.push({ key: entryKey, text });
    }
    if (!groups.size) return {};
    const policy = (await this.app.longMemory.policies.get(input.actorId)).value;
    if (!policy.embedding) return { error: '请在记忆整理方式中配置嵌入服务后使用世界书向量激活。' };
    const config = policy.embedding;
    const embeddings = this.app.longMemory.embeddings;
    const matches: Record<string, number> = {};
    const controller = signal ?? new AbortController().signal;
    try {
      for (const group of groups.values()) {
        controller.throwIfAborted();
        if (!group.query) continue;
        const texts = group.entries.map(item => item.text);
        const matrixKey = createHash('sha256').update(JSON.stringify([input.actorId, embeddings.signature(config),
          group.entries.map(item => item.key), texts])).digest('hex');
        let dimensions = this.dimensions.get(matrixKey);
        const cached = dimensions !== undefined && this.matrices.has(matrixKey);
        let query = embeddings.cached(input.actorId, config, group.query, 'query');
        if (input.preview && (!cached || !query)) {
          return { error: '世界书语义查询尚未执行；只读预览保留关键词激活，正式发送后可检查向量结果。' };
        }
        query ??= (await embeddings.embed(input.actorId, config, [group.query], controller, 'query')).vectors[0];
        let vectors: ArrayBuffer | undefined;
        if (!cached) {
          const packed = new Float32Array(texts.length * query.dimensions);
          for (let start = 0; start < texts.length; start += 32) {
            const batch = (await embeddings.embed(input.actorId, config, texts.slice(start, start + 32), controller)).vectors;
            batch.forEach((vector, index) => {
              if (vector.dimensions !== query!.dimensions) throw new Error('世界书正文与查询的嵌入维度不一致。');
              packed.set(vector.values, (start + index) * vector.dimensions);
            });
          }
          dimensions = query.dimensions;
          vectors = packed.buffer as ArrayBuffer;
        }
        if (dimensions !== query.dimensions) throw new Error('嵌入服务的维度已改变，请核对模型配置。');
        this.ranker ??= new VectorRanker();
        const ranked = await this.ranker.rank({ key: matrixKey, dimensions, vectors, values: query.values,
          ids: group.entries.map(item => item.key), limit: policy.recallLimit, evict: this.matrices.drain() });
        this.matrices.add(matrixKey, vectorMatrixBytes(texts.length, dimensions), [input.actorId]);
        this.dimensions.set(matrixKey, dimensions);
        for (const key of this.dimensions.keys()) if (!this.matrices.has(key)) this.dimensions.delete(key);
        ranked.forEach(item => { matches[group.entries[item.index].key] = item.score; });
      }
      return { matches };
    } catch (error) {
      controller.throwIfAborted();
      // 关键词世界书仍然可用，失败原因随实际激活结果返回给预览。
      return { error: `世界书向量激活失败：${(error as Error).message}` };
    }
  }

  async close(): Promise<void> {
    await this.pending;
    await this.ranker?.close();
    this.matrices.invalidate();
    this.dimensions.clear();
  }
}
