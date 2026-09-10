import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PlatformStorage } from '@graycode/core';
import type { PlatformConversation, PlatformMessage } from '@graycode/contracts';

export function metadata(id: string): PlatformConversation {
  return { id, title: `会话 ${id}`, createdAt: 123456, updatedAt: 123456, custom: { unknownFutureField: '保留' } };
}
export function message(index: number, text = `消息 ${index}`): PlatformMessage {
  return { id: `message_${index}`, role: index % 2 ? 'model' : 'user', parts: [{ text }], timestamp: index + 1000 };
}
export async function fixture(): Promise<{ root: string; data: string; source: string; store: PlatformStorage; cleanup(): Promise<void> }> {
  const temporaryRoot = path.resolve('.tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'platform-test-'));
  const data = path.join(root, 'new');
  const source = path.join(root, 'legacy');
  await fs.mkdir(path.join(source, 'conversations'), { recursive: true });
  const store = await PlatformStorage.open(data);
  const result = { root, data, source, store, cleanup: async () => {
    await result.store.close();
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('platform-test-')) throw new Error('Unsafe fixture cleanup path.');
    await fs.rm(root, { recursive: true, force: true });
  } };
  return result;
}
