import { parentPort } from 'node:worker_threads';
import { rankVectors, type VectorRankingRequest } from './vectors';

if (!parentPort) throw new Error('向量计算必须在专用线程内运行。');
const port = parentPort;
let vectors: ArrayBuffer | undefined;
port.on('message', (input: VectorRankingRequest) => {
  try {
    if (input.vectors) vectors = input.vectors;
    if (!vectors) throw new Error('缺少向量计算数据。');
    port.postMessage({ matches: rankVectors({ ...input, vectors }) });
  }
  catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
