import * as host from '../../modules/memory';
import { createMemoryNoteRuntime } from './memory_noteRuntime';
export const { createMemoryNoteDeclaration, createMemoryNoteTool, registerMemoryNote } = createMemoryNoteRuntime(host);
