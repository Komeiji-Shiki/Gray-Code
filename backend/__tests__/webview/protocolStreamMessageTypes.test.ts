/**
 * 协议消息名单一致性单元测试（发现 5）
 *
 * 断言 STREAM_MESSAGE_TYPES 与 MESSAGE_NAMES 的覆盖关系：流式类型名单必须由
 * MESSAGE_NAMES 常量组成，防止新增/重命名流式消息时漏改任一处形成第二事实源。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import { STREAM_MESSAGE_TYPES } from '../../../webview/MessageRouter';

describe('STREAM_MESSAGE_TYPES 与 MESSAGE_NAMES 一致性', () => {
    test('STREAM_MESSAGE_TYPES 的每个值都存在于 MESSAGE_NAMES', () => {
        const messageNameValues = new Set<string>(Object.values(MESSAGE_NAMES));
        for (const type of STREAM_MESSAGE_TYPES) {
            expect(messageNameValues.has(type)).toBe(true);
        }
    });

    test('关键流式类型仍被覆盖（回归护栏）', () => {
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES.chatStream);
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES.retryStream);
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES.toolConfirmation);
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES.cancelStream);
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES['chat.rerollStream']);
        expect(STREAM_MESSAGE_TYPES).toContain(MESSAGE_NAMES['chat.editBranchStream']);
    });
});
