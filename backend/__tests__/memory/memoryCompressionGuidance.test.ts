import { createMemoryCompressDeclaration } from '../../tools/memory/memory_compress';
import { createMemoryNoteDeclaration } from '../../tools/memory/memory_note';
import { createMemoryWakeDeclaration } from '../../tools/memory/memory_wake';

describe('memory compression guidance', () => {
    test('treats successful pending compression as deferred maintenance', () => {
        const noteDescription = createMemoryNoteDeclaration().description;
        const compressDescription = createMemoryCompressDeclaration().description;
        const wakeDescription = createMemoryWakeDeclaration().description;

        expect(noteDescription).toContain('可延后的维护提示');
        expect(noteDescription).toContain('不要中断当前用户任务');
        expect(compressDescription).toContain('memory_wake 因缺少摘要失败时才必须立即处理');
        expect(compressDescription).toContain('不同作用域的独立压缩可以在同一响应中调用');
        expect(wakeDescription).toContain('pendingCompression 可延后');
        expect(noteDescription).not.toContain('下一次操作前执行 memory_compress');
    });
});
