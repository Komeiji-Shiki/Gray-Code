export interface VectorRankingInput {
  dimensions: number;
  values: number[];
  ids: string[];
  vectors: ArrayBuffer;
  limit: number;
}
export interface VectorMatch { index: number; score: number }
/**
 * 发往计算线程的请求：带 vectors 且带 key 时线程缓存矩阵；只带 key 时复用已缓存矩阵；
 * evict 列出存储线程已经淘汰或失效的矩阵，先于本次计算处理。
 */
export type VectorRankingRequest = Omit<VectorRankingInput, 'vectors'> & { vectors?: ArrayBuffer; key?: string; evict?: string[] };

/** 每行模长；累加顺序与逐行计算时相同，预计算与即时计算的分数逐位一致。 */
export function vectorNorms(vectors: ArrayBuffer, dimensions: number): Float64Array {
  const values = new DataView(vectors), rows = Math.floor(vectors.byteLength / (dimensions * 4)), norms = new Float64Array(rows);
  for (let index = 0; index < rows; index++) {
    let square = 0;
    const offset = index * dimensions * 4;
    for (let column = 0; column < dimensions; column++) { const value = values.getFloat32(offset + column * 4, true); square += value * value; }
    norms[index] = Math.sqrt(square);
  }
  return norms;
}

/** 精确余弦相似度；只保留排名所需的候选，得分相同按原有 ID 和输入顺序排序。 */
export function rankVectors(input: VectorRankingInput, norms: Float64Array = vectorNorms(input.vectors, input.dimensions)): VectorMatch[] {
  const values = new DataView(input.vectors), heap: VectorMatch[] = [];
  const norm = Math.sqrt(input.values.reduce((sum, x) => sum + x * x, 0));
  const compare = (a: VectorMatch, b: VectorMatch) => b.score - a.score || input.ids[a.index].localeCompare(input.ids[b.index]) || a.index - b.index;
  for (let index = 0; index < input.ids.length; index++) {
    let dot = 0;
    const offset = index * input.dimensions * 4;
    for (let column = 0; column < input.dimensions; column++) dot += values.getFloat32(offset + column * 4, true) * input.values[column];
    // sqrt 只在平方和为 0 时为 0，与原先判断 square 等价。
    const score = norm && norms[index] ? dot / (norm * norms[index]) : 0;
    if (!(score > 0)) continue;
    const item = { index, score };
    if (heap.length < input.limit) {
      heap.push(item);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compare(heap[child], heap[parent]) <= 0) break;
        [heap[child], heap[parent]] = [heap[parent], heap[child]]; child = parent;
      }
    } else if (compare(item, heap[0]) < 0) {
      heap[0] = item;
      let parent = 0;
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
        if (compare(heap[child], heap[parent]) <= 0) break;
        [heap[child], heap[parent]] = [heap[parent], heap[child]]; parent = child;
      }
    }
  }
  return heap.sort(compare);
}

/** 候选矩阵占用：Float32 向量加每行 Float64 模长。 */
export const vectorMatrixBytes = (rows: number, dimensions: number) => rows * (dimensions * 4 + 8);

/**
 * 存储线程一侧记录计算线程已持有哪些矩阵，按最近使用顺序在字节预算内保留多个范围。
 * 只在计算成功后登记，因此这里的条目始终是线程所持有矩阵的子集；淘汰与失效随下一次请求带给线程。
 * 最新登记的矩阵即使超过预算也保留，与原先只缓存最近一次的行为一致。
 */
export class VectorMatrixCache {
  private readonly entries = new Map<string, { bytes: number; scopes: readonly string[] }>();
  private bytes = 0;
  private evicted: string[] = [];
  constructor(readonly budget: number) {}
  get size() { return this.entries.size; }
  get totalBytes() { return this.bytes; }
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return !!entry;
  }
  add(key: string, bytes: number, scopes: readonly string[]): void {
    this.remove(key, false);
    this.entries.set(key, { bytes, scopes }); this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.budget || oldest === key) break;
      this.remove(oldest);
    }
  }
  /** scopeIds 缺省表示无法判断修改范围，全部失效。 */
  invalidate(scopeIds?: Iterable<string>): void {
    const targets = scopeIds === undefined ? undefined : new Set(scopeIds);
    for (const [key, entry] of [...this.entries]) if (!targets || entry.scopes.some(scope => targets.has(scope))) this.remove(key);
  }
  /** 取出待通知线程释放的矩阵；请求未送达时用 discard 放回。 */
  drain(): string[] { const keys = this.evicted; this.evicted = []; return keys; }
  discard(keys: Iterable<string>): void { for (const key of keys) { this.remove(key, false); this.evicted.push(key); } }
  private remove(key: string, notify = true): void {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; if (notify) this.evicted.push(key); }
  }
}
