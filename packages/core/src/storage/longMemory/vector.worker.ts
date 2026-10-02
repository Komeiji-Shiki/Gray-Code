import { parentPort } from 'node:worker_threads';
import { rankVectors, vectorNorms, type VectorRankingRequest } from './vectors';

if (!parentPort) throw new Error('向量计算必须在专用线程内运行。');
const port = parentPort;
// 存储线程按字节预算决定保留哪些范围的矩阵，这里只按其指示保存和释放；模长在载入时计算一次。
const matrices = new Map<string, { vectors: ArrayBuffer; norms: Float64Array }>();
port.on('message', (input: VectorRankingRequest) => {
  try {
    for (const key of input.evict ?? []) matrices.delete(key);
    const matrix = input.vectors ? { vectors: input.vectors, norms: vectorNorms(input.vectors, input.dimensions) } : input.key ? matrices.get(input.key) : undefined;
    if (!matrix) throw new Error('缺少向量计算数据。');
    if (input.vectors && input.key) matrices.set(input.key, matrix);
    port.postMessage({ matches: rankVectors({ ...input, vectors: matrix.vectors }, matrix.norms) });
  }
  catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
