import * as host from '../../modules/memory';
import { createMemoryForgetRuntime } from './memory_forgetRuntime';
export const { createMemoryForgetDeclaration, createMemoryForgetTool, registerMemoryForget } = createMemoryForgetRuntime(host);
