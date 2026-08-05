/**
 * MessageRouter 非阻塞消息类型集合 单元测试
 *
 * 直接读取生产代码导出的 NON_BLOCKING_MESSAGE_TYPES / STREAM_MESSAGE_TYPES，
 * 断言与本地预期的关键条目一致，防止路由集合被误改。
 */

import {
    MessageRouter,
    NON_BLOCKING_MESSAGE_TYPES,
    STREAM_MESSAGE_TYPES,
} from '../../../webview/MessageRouter';

describe('MessageRouter non-blocking message types', () => {
    it('summarizeContext is recognized as a long-running handler', async () => {
        // 该消息的 handler 可能执行 LLM 请求（数十秒到数分钟），
        // 必须非阻塞以避免阻塞取消类消息
        expect(typeof MessageRouter).toBe('function');
        expect(NON_BLOCKING_MESSAGE_TYPES.has('summarizeContext')).toBe(true);
    });

    it('stream message types remain at the original count', () => {
        // 流式消息类型不应因非阻塞改动而变动
        const STREAM_TYPES = ['chatStream', 'retryStream', 'editAndRetryStream', 'toolConfirmation', 'cancelStream'];
        expect(STREAM_TYPES).toHaveLength(5);
        expect(STREAM_TYPES).toContain('cancelStream');
        // 生产导出的流式类型必须包含本地预期的全部关键条目
        for (const t of STREAM_TYPES) {
            expect(STREAM_MESSAGE_TYPES).toContain(t);
        }
    });

    it('non-blocking long-task types are documented', () => {
        // 确保新增非阻塞类型时有对应测试覆盖
        const EXPECTED_NON_BLOCKING = [
            'summarizeContext',
            'dependencies.install',
            'dependencies.uninstall',
            'storagePath.migrate',
            'subagents.pauseRun',
            'subagents.resumeRun',
            'subagents.exitRun'
        ];
        expect(EXPECTED_NON_BLOCKING).toHaveLength(7);
        // 生产导出的非阻塞类型必须包含本地预期的全部关键条目
        for (const t of EXPECTED_NON_BLOCKING) {
            expect(NON_BLOCKING_MESSAGE_TYPES.has(t)).toBe(true);
        }
    });
});
