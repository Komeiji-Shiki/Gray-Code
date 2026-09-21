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

    test('结构化数组使用紧凑 JSON，解析后的数据保持相同', () => {
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
        }));
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

describe('工具结果信息完整性与紧凑输出', () => {
    test('失败保留错误码、退出码、恢复游标和空值', () => {
        const result = serializeToolResultForLLM('run_command', {
            success: false, error: '命令失败', code: 'PROCESS_FAILED', retryable: false,
            data: { output: 'stderr 原文', exitCode: 2, nextCursor: 123, truncated: true, signal: null },
        });
        expect(result).toContain('"code":"PROCESS_FAILED"');
        expect(result).toContain('"retryable":false');
        expect(result).toContain('"exitCode":2');
        expect(result).toContain('"nextCursor":123');
        expect(result).toContain('"truncated":true');
        expect(result).toContain('"signal":null');
        expect(result.match(/stderr 原文/g)).toHaveLength(1);
    });

    test('文本批量结果保留分页与统计，不把截断误报成完整结果', () => {
        const result = serializeToolResultForLLM('search_in_files', {
            success: true, pending: true,
            data: { results: [{ path: 'a.ts', content: '第一个匹配' }], totalCount: 50, truncated: true, nextCursor: 'page-2' },
        });
        expect(result).toContain('"pending":true');
        expect(result).toContain('"totalCount":50');
        expect(result).toContain('"truncated":true');
        expect(result).toContain('"nextCursor":"page-2"');
    });

    test('修改前后的文本保留字段身份，单一文件正文仍原样输出', () => {
        const result = serializeToolResultForLLM('patch', { success: true, data: { originalContent: '旧内容', newContent: '新内容' } });
        expect(result).toContain('originalContent:\n旧内容');
        expect(result).toContain('newContent:\n新内容');
        expect(serializeToolResultForLLM('read_file', { success: true, data: { content: 'C:\\temp\\file\n下一行' } })).toBe('C:\\temp\\file\n下一行');
    });

    test('混合结果中的字符串、null 和数字不会导致整个序列化失败', () => {
        const result = serializeToolResultForLLM('mixed', { success: true, data: { results: [{ content: '正文' }, null, 0, '其他结果'] } });
        expect(result).toContain('正文\n\nnull\n\n0\n\n"其他结果"');
    });

    test('纯结构化失败结果和可读消息只输出一次', () => {
        const result = serializeToolResultForLLM('delete_file', {
            success: false, error: '部分失败', data: { results: [{ id: 'one', success: true }], message: '已删除一条', affected: ['one'] },
        });
        expect(result.match(/已删除一条/g)).toHaveLength(1);
        expect(result).toContain('"affected":["one"]');
        expect(result).toContain('"success":true');
    });
});
