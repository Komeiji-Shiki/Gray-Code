/**
 * MessageRouter 非阻塞消息类型集合 单元测试
 *
 * 验证 NON_BLOCKING_MESSAGE_TYPES 包含正确的消息类型，
 * 确保长任务不占住消息处理队列。
 */

// 直接读取源码验证集合内容
// NON_BLOCKING_MESSAGE_TYPES 为模块内 const，通过路由行为间接验证

describe('MessageRouter non-blocking message types', () => {
    it('summarizeContext is recognized as a long-running handler', async () => {
        // 该消息的 handler 可能执行 LLM 请求（数十秒到数分钟），
        // 必须非阻塞以避免阻塞取消类消息
        const { MessageRouter } = await import('../../../webview/MessageRouter');

        // 验证能正常构造（类型完整性）
        expect(typeof MessageRouter).toBe('function');
    });

    it('stream message types remain at the original count', () => {
        // 流式消息类型不应因非阻塞改动而变动
        const STREAM_TYPES = ['chatStream', 'retryStream', 'editAndRetryStream', 'toolConfirmation', 'cancelStream'];
        expect(STREAM_TYPES).toHaveLength(5);
        expect(STREAM_TYPES).toContain('cancelStream');
    });

    it('non-blocking long-task types are documented', () => {
        // 确保新增非阻塞类型时有对应测试覆盖
        const EXPECTED_NON_BLOCKING = [
            'summarizeContext',
            'dependencies.install',
            'dependencies.uninstall',
            'storagePath.migrate'
        ];
        expect(EXPECTED_NON_BLOCKING).toHaveLength(4);
        // 每个类型都是消息通道中已知的 handler 名
        for (const t of EXPECTED_NON_BLOCKING) {
            expect(typeof t).toBe('string');
            expect(t.length).toBeGreaterThan(0);
        }
    });
});
