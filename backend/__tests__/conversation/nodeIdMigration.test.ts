/**
 * BR-02：旧历史惰性补 ID 使用确定性节点 ID，同一历史多次迁移得到同一组 ID。
 * 读取入口的迁移与写回由平台 historyView 完成（packages/core/tests/historyOutline.test.ts）。
 */

import { deterministicNodeId } from '../../modules/conversation/manager/nodeId';

describe('deterministicNodeId（BR-02 确定性生成）', () => {
    test('同一 (namespace, seed) 产出同一 ID，不同 seed 产出不同 ID', () => {
        const a1 = deterministicNodeId('conv-1', 'user|0|1000');
        const a2 = deterministicNodeId('conv-1', 'user|0|1000');
        expect(a1).toBe(a2);
        expect(deterministicNodeId('conv-2', 'user|0|1000')).not.toBe(a1);
        expect(deterministicNodeId('conv-1', 'user|1|1000')).not.toBe(a1);
        expect(deterministicNodeId('conv-1', 'model|0|1000')).not.toBe(a1);
        // UUID 格式
        expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
