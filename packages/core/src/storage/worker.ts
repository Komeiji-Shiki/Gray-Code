import { parentPort, workerData } from 'node:worker_threads';
import { PlatformDatabase } from './database';
import { errorDetails } from '../errors';
import type { StorageRequest, StorageReply } from './protocol';

if (!parentPort) throw new Error('Storage worker must run in a worker thread.');
const port = parentPort;
try {
  const database = new PlatformDatabase(workerData.directory);
  port.on('message', (request: StorageRequest) => {
    try {
      const value = database.execute(request.method, request.input as never);
      port.postMessage({ type: 'reply', id: request.id, value } satisfies StorageReply);
      if (request.method === 'close') port.close();
    } catch (error) {
      port.postMessage({ type: 'error', id: request.id, error: errorDetails(error) } satisfies StorageReply);
    }
  });
  port.postMessage({ type: 'ready' } satisfies StorageReply);
} catch (error) {
  port.postMessage({ type: 'error', error: errorDetails(error) } satisfies StorageReply);
  port.close();
}
