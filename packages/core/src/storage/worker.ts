import { parentPort, workerData } from 'node:worker_threads';
import { PlatformDatabase } from './database';
import { errorDetails } from '../errors';
import type { StorageRequest, StorageReply, StorageMethod, StorageOperations } from './protocol';

if (!parentPort) throw new Error('Storage worker must run in a worker thread.');
const port = parentPort;
try {
  const database = new PlatformDatabase(workerData.directory);
  // 向量计算期间允许独立读取；一旦有排队写入，后续请求继续按原顺序执行。
  const concurrentReads = new Set<StorageMethod>(['getRecord', 'getVersionedRecord', 'listRecords', 'readRecordPage',
    'getConversation', 'listConversations', 'readConversationState', 'readHistory', 'readFullHistory', 'historyInfo',
    'getRun', 'getRunByRequestKey', 'listRuns', 'readRunEvents', 'readUsageState', 'recordRevisions',
    'getSnapshot', 'listSnapshots', 'longMemoryScopes', 'longMemoryState', 'longMemoryRead', 'longMemoryTopics', 'longMemoryGraph', 'longMemoryBrowse']);
  const queue: StorageRequest[] = [];
  let computing = false;
  const failure = (request: StorageRequest, error: unknown) => {
    port.postMessage({ type: 'error', id: request.id, error: errorDetails(error) } satisfies StorageReply);
  };
  const completed = (request: StorageRequest, value: unknown) => {
    port.postMessage({ type: 'reply', id: request.id, value } satisfies StorageReply);
  };
  const isVector = (request: StorageRequest) => request.method === 'longMemoryRecall'
    && !!(request.input as StorageOperations['longMemoryRecall']['input']).vector;
  function dispatch(request: StorageRequest) {
    try {
      if (isVector(request)) {
        computing = true;
        void database.recallMemory(request.input as StorageOperations['longMemoryRecall']['input'])
          .then(value => completed(request, value)).catch(error => failure(request, error)).finally(() => {
            computing = false;
            while (queue.length && !computing) dispatch(queue.shift()!);
          });
        return;
      }
      if (request.method === 'close') {
        void database.closeVectorWorker().then(() => { database.execute('close', undefined); completed(request, undefined); port.close(); })
          .catch(error => failure(request, error));
        return;
      }
      const value = database.execute(request.method, request.input as never);
      completed(request, value);
    } catch (error) { failure(request, error); }
  }
  port.on('message', (request: StorageRequest) => {
    const independentRead = concurrentReads.has(request.method) || request.method === 'longMemoryRecall' && !isVector(request);
    if (computing && (queue.length > 0 || !independentRead)) queue.push(request);
    else dispatch(request);
  });
  port.postMessage({ type: 'ready' } satisfies StorageReply);
} catch (error) {
  port.postMessage({ type: 'error', error: errorDetails(error) } satisfies StorageReply);
  port.close();
}
