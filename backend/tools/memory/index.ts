/**
 * Memory 工具模块
 *
 * OptMem 风格永久记忆系统的工具集。
 */

import type { ToolRegistration } from '../types';
import { registerMemoryWake } from './memory_wake';
import { registerMemoryNote } from './memory_note';
import { registerMemoryRecall } from './memory_recall';
import { registerMemoryCompress } from './memory_compress';
import { registerMemoryZoom } from './memory_zoom';
import { registerMemoryForget } from './memory_forget';
import { registerMemoryConfig } from './memory_config';

export { registerMemoryWake } from './memory_wake';
export { registerMemoryNote } from './memory_note';
export { registerMemoryRecall } from './memory_recall';
export { registerMemoryCompress } from './memory_compress';
export { registerMemoryZoom } from './memory_zoom';
export { registerMemoryForget } from './memory_forget';
export { registerMemoryConfig } from './memory_config';

export { MEMORY_TOOL_NAMES } from '../../modules/memory';

export function getMemoryToolRegistrations(): ToolRegistration[] {
    return [
        registerMemoryWake,
        registerMemoryNote,
        registerMemoryRecall,
        registerMemoryCompress,
        registerMemoryZoom,
        registerMemoryForget,
        registerMemoryConfig,
    ];
}
