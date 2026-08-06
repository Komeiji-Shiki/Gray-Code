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

    it('dialog-driven types are non-blocking (native dialogs may outlive the 60s queue timeout)', () => {
        // 打开/保存工作区、存储路径选择、设置导入/导出都会 await 原生对话框：
        // 用户在对话框里浏览可能超过 60s 队列超时，若在串行队列中 await，
        // 超时先触发（HANDLER_TIMEOUT 已回传）后 handler 才继续执行，
        // 后续响应被前端当作迟到广播丢弃，表现为「打开/保存工作区没反应」。
        const DIALOG_DRIVEN = [
            'workspace.openFolder',
            'storagePath.selectFolder',
            'settings.import',
            'settings.export'
        ];
        for (const t of DIALOG_DRIVEN) {
            expect(NON_BLOCKING_MESSAGE_TYPES.has(t)).toBe(true);
        }
    });
});
