import { assertSafeStorageId } from '../../modules/conversation/storage';
import { DiffStorageManager } from '../../modules/conversation';

describe('conversation storage path segment validation', () => {
    test.each(['conv_123_abc', 'c-branch-validator', '550e8400-e29b-41d4-a716-446655440000'])(
        'accepts generated/legacy-safe id %s',
        value => expect(() => assertSafeStorageId(value, 'conversation id')).not.toThrow()
    );

    test.each(['', '.', '..', '../victim', '..\\victim', 'C:evil', 'conv%2f..%2fvictim', 'x.json'])(
        'rejects unsafe path segment %s',
        value => expect(() => assertSafeStorageId(value, 'conversation id')).toThrow(/Unsafe conversation id/)
    );
});

describe('diff sidecar path validation', () => {
    test('rejects traversal in both conversation and diff ids', async () => {
        const manager = new (DiffStorageManager as any)('D:\\safe-root') as DiffStorageManager;
        await expect(manager.loadDiffContent('../outside', 'diff_1')).rejects.toThrow(/Unsafe conversation id/);
        await expect(manager.loadDiffContent('conv_1', '../outside')).rejects.toThrow(/Unsafe diff id/);
        // fork 语义：加载路径对不安全 id 优雅降级返回 null（防御纵深，不抛错中断 UI）
        await expect(manager.loadGlobalDiff('../outside')).resolves.toBeNull();
    });
});
