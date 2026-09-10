import * as host from '../../modules/memory';
import { createMemoryCompressRuntime } from './memory_compressRuntime';
export const { createMemoryCompressDeclaration, createMemoryCompressTool, registerMemoryCompress } = createMemoryCompressRuntime(host);
