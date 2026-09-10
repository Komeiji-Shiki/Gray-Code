import * as host from '../../modules/memory';
import { createMemoryWakeRuntime } from './memory_wakeRuntime';
export const { createMemoryWakeDeclaration, createMemoryWakeTool, registerMemoryWake } = createMemoryWakeRuntime(host);
