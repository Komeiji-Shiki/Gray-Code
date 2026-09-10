import * as host from '../../modules/memory';
import { createMemoryConfigRuntime } from './memory_configRuntime';
export const { createMemoryConfigDeclaration, createMemoryConfigTool, registerMemoryConfig } = createMemoryConfigRuntime(host);
