import { createEngineeringLogDeclaration } from '../../tools/memory/engineeringLog';

describe('memory compression guidance', () => {
    test('treats successful pending compression as deferred maintenance', () => {
        const description = createEngineeringLogDeclaration().description;

        expect(description).toContain('成功结果中的 pendingCompression 可延后至当前交付完成');
        expect(description).toContain('仅 wake 因缺少摘要失败时先压缩再重试');
        expect(description).toContain('不同作用域的独立压缩可以同时调用');
        expect(description).not.toContain('下一次操作前执行');
    });
});
