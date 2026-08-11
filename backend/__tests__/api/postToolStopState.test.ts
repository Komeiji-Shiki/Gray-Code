/**
 * postToolStopState 单元测试：工具结果 → 是否停止工具循环
 *
 * 覆盖点（对应「命令超时不暂停对话」修复的判定链）：
 * - cancelled:true 的结果 → shouldStop（用户取消语义保持）
 * - 失败但未 cancelled 的结果（如命令超时）→ shouldStop:false，错误回传 LLM 继续对话
 * - requiresUserConfirmation / 审批门闸 → shouldStop（approval）
 * - 成功结果 → 不停止
 */

import { resolvePostToolStopState } from '../../modules/api/chat/services/postToolStopState';

describe('resolvePostToolStopState', () => {
    const call = (id: string, name = 'execute_command') => ({ id, name, args: {} });

    test('cancelled:true → shouldStop:true（用户取消语义保持）', () => {
        const state = resolvePostToolStopState(
            [call('call-1')],
            [{
                id: 'call-1',
                name: 'execute_command',
                result: { success: false, error: 'User cancelled the command execution.', cancelled: true }
            }]
        );

        expect(state.shouldStop).toBe(true);
        expect(state.reason).toBe('cancelled');
    });

    test('失败但未 cancelled（如命令超时）→ shouldStop:false，错误交由 LLM 继续', () => {
        const state = resolvePostToolStopState(
            [call('call-1')],
            [{
                id: 'call-1',
                name: 'execute_command',
                result: { success: false, error: 'Command timed out after 60000ms', cancelled: false }
            }]
        );

        expect(state.shouldStop).toBe(false);
        expect(state.reason).toBeNull();
    });

    test('requiresUserConfirmation:true → shouldStop:true（approval）', () => {
        const state = resolvePostToolStopState(
            [call('p-1', 'create_plan')],
            [{
                id: 'p-1',
                name: 'create_plan',
                result: { success: true, requiresUserConfirmation: true }
            }]
        );

        expect(state.shouldStop).toBe(true);
        expect(state.reason).toBe('approval');
    });

    test('成功结果 → shouldStop:false', () => {
        const state = resolvePostToolStopState(
            [call('call-1')],
            [{
                id: 'call-1',
                name: 'execute_command',
                result: { success: true, data: { output: 'hello' } }
            }]
        );

        expect(state.shouldStop).toBe(false);
        expect(state.reason).toBeNull();
    });

    test('多个结果：其中一个 cancelled → shouldStop:true', () => {
        const state = resolvePostToolStopState(
            [call('call-1'), call('call-2', 'read_file')],
            [
                {
                    id: 'call-1',
                    name: 'execute_command',
                    result: { success: true, data: { output: 'ok' } }
                },
                {
                    id: 'call-2',
                    name: 'read_file',
                    result: { success: false, error: 'cancelled', cancelled: true }
                }
            ]
        );

        expect(state.shouldStop).toBe(true);
        expect(state.reason).toBe('cancelled');
    });
});
