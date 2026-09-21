import { rankVectors, type VectorRankingInput } from '../src/storage/longMemory/vectors';

test('有界候选与全量精确排序一致，包括同分、零向量和负相似度', () => {
  const dimensions = 16, count = 240, buffer = new ArrayBuffer(count * dimensions * 4), view = new DataView(buffer);
  let state = 17;
  const random = () => { state = Math.imul(state, 1664525) + 1013904223 | 0; return (state >>> 0) / 0x100000000 * 2 - 1; };
  const values = Array.from({ length: dimensions }, random), ids = Array.from({ length: count }, (_, index) => `item-${index % 7}`);
  for (let index = 0; index < count; index++) for (let column = 0; column < dimensions; column++)
    view.setFloat32((index * dimensions + column) * 4, index < 5 ? values[column] : index < 10 ? 0 : random(), true);
  const input: VectorRankingInput = { dimensions, values, ids, vectors: buffer, limit: 41 };
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  const expected = ids.map((id, index) => {
    let dot = 0, square = 0;
    for (let column = 0; column < dimensions; column++) {
      const value = view.getFloat32((index * dimensions + column) * 4, true); dot += value * values[column]; square += value * value;
    }
    return { id, index, score: norm && square ? dot / (norm * Math.sqrt(square)) : 0 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const limit of [1, 41, 101]) expect(rankVectors({ ...input, limit })).toEqual(expected.slice(0, limit).map(({ id, ...value }) => value));
  expect(rankVectors({ ...input, values: Array(dimensions).fill(0) })).toEqual([]);
});
