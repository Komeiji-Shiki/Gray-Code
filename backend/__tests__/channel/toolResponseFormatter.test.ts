/**
 * serializeToolResultForLLM 共享序列化器测试（F-02）
 *
 * 覆盖：批量工具部分失败时，模型同时看到顶层错误、成功结果和失败详情；
 * 成功文本不发生 JSON 二次转义；命令输出、取消标记和 data.message 不回归。
 */

import { serializeToolResultForLLM } from '../../modules/channel/formatters/toolResponseFormatter';

describe('serializeToolResultForLLM - 部分成功结果（F-02）', () => {
    test('read_file 一项成功一项失败时，成功内容与失败详情都可见', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: false,
            error: '1 file failed to read',
            data: {
                results: [
                    { success: true, path: 'a.txt', content: 'first line\nsecond line', lineCount: 2 },
                    { success: false, path: 'missing.txt', error: 'ENOENT' }
                ],
                successCount: 1,
                failCount: 1,
                totalCount: 2
            }
        });

        expect(result).toContain('Error: 1 file failed to read');
        expect(result).toContain('Partial results:');
        expect(result).toContain('[successCount=1, failCount=1, totalCount=2]');
        expect(result).toContain('[a.txt, 2 lines]');
        expect(result).toContain('first line');
        expect(result).toContain('[missing.txt, FAILED | {"error":"ENOENT"}]');
    });

    test('成功内容包含 Windows 路径反斜杠时不发生二次转义', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: false,
            error: '1 file failed to read',
            data: {
                results: [
                    { success: true, path: 'C:\\repo\\a.txt', content: 'path = C:\\temp\\x.txt', lineCount: 1 },
                    { success: false, path: 'b.txt', error: 'ENOENT' }
                ],
                successCount: 1,
                failCount: 1,
                totalCount: 2
            }
        });

        // 文本原样透出：单反斜杠，不能被 JSON.stringify 二次转义成双反斜杠
        expect(result).toContain('path = C:\\temp\\x.txt');
        expect(result).not.toContain('C:\\\\temp\\\\x.txt');
    });

    test('失败项的 ENOENT 详情对模型可见', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: false,
            error: '1 file failed to read',
            data: {
                results: [
                    { success: true, path: 'a.txt', content: 'ok' },
                    { success: false, path: 'missing.txt', error: 'ENOENT' }
                ],
                successCount: 1,
                failCount: 1,
                totalCount: 2
            }
        });

        expect(result).toContain('ENOENT');
    });

    test('保留 data.output 特殊处理（execute_command 失败输出原格式）', () => {
        const result = serializeToolResultForLLM('execute_command', {
            success: false,
            error: 'Command exited with code 1',
            data: {
                output: 'Error: module not found\n  at main.js:1:5'
            }
        });

        expect(result).toBe('Error: Command exited with code 1\n\nOutput:\nError: module not found\n  at main.js:1:5');
    });

    test('用户取消时仍显示取消标记', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: false,
            error: 'User cancelled',
            cancelled: true,
            data: {
                results: [
                    { success: true, path: 'a.txt', content: 'partial' }
                ],
                successCount: 1,
                failCount: 0,
                totalCount: 1
            }
        });

        expect(result).toContain('Error: User cancelled');
        expect(result).toContain('[cancelled by user]');
    });

    test('data.message 不再丢失', () => {
        const result = serializeToolResultForLLM('delete_file', {
            success: false,
            error: '1 file failed to delete',
            data: {
                message: 'Deleted 2 of 3 files',
                results: [
                    { success: true, path: 'a.txt' },
                    { success: false, path: 'b.txt', error: 'ENOENT' }
                ],
                successCount: 2,
                failCount: 1,
                totalCount: 3
            }
        });

        expect(result).toContain('Message: Deleted 2 of 3 files');
    });

    test('子代理失败路径（partialResponse）保留 steps/toolsUsed（HIGH-1）', () => {
        const result = serializeToolResultForLLM('subagents', {
            success: false,
            error: 'SubAgent execution failed',
            data: {
                agentName: 'Reviewer',
                runId: 'subagent_run_fail_1',
                partialResponse: '已读完 2 页，发现 3 处问题…',
                steps: 2,
                toolsUsed: ['read_file', 'search_in_files']
            }
        });

        expect(result).toContain('Error: SubAgent execution failed');
        expect(result).toContain('Progress: steps=2, toolsUsed=["read_file","search_in_files"]');
        expect(result).toContain('Partial response:');
        expect(result).toContain('已读完 2 页，发现 3 处问题…');
    });

    test('子代理失败且未调用工具时输出 toolsUsed=[]（中性陈述）', () => {
        const result = serializeToolResultForLLM('subagents', {
            success: false,
            error: 'SubAgent execution failed',
            data: {
                agentName: 'Reviewer',
                runId: 'subagent_run_fail_2',
                partialResponse: '未能完成',
                steps: 0,
                toolsUsed: []
            }
        });

        expect(result).toContain('Progress: steps=0, toolsUsed=[]');
        expect(result).toContain('Partial response:');
    });
});

describe('serializeToolResultForLLM - 原有行为不回归', () => {
    test('全成功文本数组输出不变（无 Partial results 前缀）', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: true,
            data: {
                results: [
                    { success: true, path: 'a.txt', content: 'AAA', lineCount: 1 },
                    { success: true, path: 'b.txt', content: 'BBB', lineCount: 1 }
                ],
                successCount: 2,
                failCount: 0,
                totalCount: 2
            }
        });

        expect(result).not.toContain('Partial results:');
        expect(result).toContain('AAA');
        expect(result).toContain('BBB');
    });

    test('全结构化数组仍输出格式化 JSON', () => {
        const result = serializeToolResultForLLM('list_files', {
            success: true,
            data: {
                results: [
                    { path: 'a.txt', type: 'file' },
                    { path: 'src', type: 'dir' }
                ]
            }
        });

        expect(result).toBe(JSON.stringify({
            results: [
                { path: 'a.txt', type: 'file' },
                { path: 'src', type: 'dir' }
            ]
        }, null, 2));
    });

    test('没有 data 的普通错误仍只输出错误信息', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: false,
            error: 'File not found'
        });

        expect(result).toBe('Error: File not found');
    });

    test('混合数组（部分含文本）在无错误时也逐项格式化，不做整体 JSON', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: true,
            data: {
                results: [
                    { success: true, path: 'a.txt', content: 'text content' },
                    { success: false, path: 'b.txt', error: 'ENOENT' }
                ]
            }
        });

        expect(result).toContain('text content');
        expect(result).toContain('ENOENT');
        // 不能整体 JSON.stringify（会把文本内容二次转义）
        expect(result).not.toContain('"content": "text content"');
    });
});

describe('serializeToolResultForLLM - agentInbox 模型可见（消息插入功能补齐）', () => {
    const inbox = (text: string) => [
        { fromRunId: 'run_a', fromAgentName: 'Agent A', text, threadId: 't1', hopDepth: 1, createdAt: 1 }
    ];

    it('文本路径（data.output，execute_command）补渲染 agentInbox 文本段', () => {
        const result = serializeToolResultForLLM('execute_command', {
            success: true,
            data: {
                output: 'build ok',
                exitCode: 0,
                agentInbox: inbox('please stop')
            }
        });

        expect(result).toContain('build ok');
        expect(result).toContain('[Agent inbox messages]');
        expect(result).toContain('- from Agent A: please stop');
    });

    it('顶层优先渲染（避免 data 重复段）', () => {
        const result = serializeToolResultForLLM('read_file', {
            success: true,
            agentInbox: inbox('top-level only'),
            data: {
                results: [{ success: true, path: 'a.txt', content: 'AAA', lineCount: 1 }],
                agentInbox: inbox('data-level only')
            }
        });

        expect(result).toContain('- from Agent A: top-level only');
        expect(result).not.toContain('data-level only');
    });

    it('错误路径同样带出 agentInbox', () => {
        const result = serializeToolResultForLLM('execute_command', {
            success: false,
            error: 'Command exited with code 1',
            agentInbox: inbox('fix it'),
            data: { output: 'boom' }
        });

        expect(result).toContain('Error: Command exited with code 1');
        expect(result).toContain('- from Agent A: fix it');
    });

    it('无 fromAgentName 时用 fromRunId 兜底', () => {
        const result = serializeToolResultForLLM('execute_command', {
            success: true,
            data: {
                output: 'ok',
                agentInbox: [{ fromRunId: 'run_x', text: 'hi' }]
            }
        });

        expect(result).toContain('- from run_x: hi');
    });

    it('无 agentInbox 时输出与原来一致（不引入空段）', () => {
        const result = serializeToolResultForLLM('execute_command', {
            success: true,
            data: { output: 'plain' }
        });

        expect(result).not.toContain('[Agent inbox messages]');
        expect(result).toContain('plain');
    });
});
