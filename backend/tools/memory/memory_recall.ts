import * as host from '../../modules/memory';
import { createMemoryRecallRuntime } from './memory_recallRuntime';
export const { createMemoryRecallDeclaration, createMemoryRecallTool, registerMemoryRecall } = createMemoryRecallRuntime(host);
