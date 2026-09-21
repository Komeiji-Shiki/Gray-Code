export interface VectorRankingInput {
  dimensions: number;
  values: number[];
  ids: string[];
  vectors: ArrayBuffer;
  limit: number;
}
export interface VectorMatch { index: number; score: number }
export type VectorRankingRequest = Omit<VectorRankingInput, 'vectors'> & { vectors?: ArrayBuffer };

/** 精确余弦相似度；只保留排名所需的候选，得分相同按原有 ID 和输入顺序排序。 */
export function rankVectors(input: VectorRankingInput): VectorMatch[] {
  const values = new DataView(input.vectors), heap: VectorMatch[] = [];
  const norm = Math.sqrt(input.values.reduce((sum, x) => sum + x * x, 0));
  const compare = (a: VectorMatch, b: VectorMatch) => b.score - a.score || input.ids[a.index].localeCompare(input.ids[b.index]) || a.index - b.index;
  for (let index = 0; index < input.ids.length; index++) {
    let dot = 0, square = 0;
    const offset = index * input.dimensions * 4;
    for (let column = 0; column < input.dimensions; column++) {
      const value = values.getFloat32(offset + column * 4, true);
      dot += value * input.values[column]; square += value * value;
    }
    const score = norm && square ? dot / (norm * Math.sqrt(square)) : 0;
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
