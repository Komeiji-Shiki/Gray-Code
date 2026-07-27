import { validateToolArgs } from '../../tools/validateToolArgs';
import type { ToolParameterSchema } from '../../tools/coerceToolArgs';

function schema(
    properties: Record<string, any>,
    required?: string[]
): ToolParameterSchema {
    return { type: 'object', properties, required };
}

describe('validateToolArgs', () => {
    // ==================== 基础守卫 ====================

    it('没有 schema 时返回 null', () => {
        expect(validateToolArgs('test', { a: 1 }, undefined)).toBeNull();
    });

    it('参数完全符合 schema 时返回 null', () => {
        const s = schema(
            {
                path: { type: 'string' },
                content: { type: 'string' }
            },
            ['path', 'content']
        );

        expect(validateToolArgs('write_file', { path: 'a.txt', content: 'hello' }, s)).toBeNull();
    });

    // ==================== 必需字段缺失 ====================

    it('缺少必需参数时返回可读错误', () => {
        const s = schema(
            {
                path: { type: 'string' },
                content: { type: 'string' }
            },
            ['path', 'content']
        );

        const error = validateToolArgs('write_file', { path: 'a.txt' }, s);

        expect(error).not.toBeNull();
        expect(error).toContain('write_file failed');
        expect(error).toContain('The required parameter `content` is missing');
    });

    it('缺少多个必需参数时列出所有缺失项', () => {
        const s = schema(
            {
                path: { type: 'string' },
                content: { type: 'string' }
            },
            ['path', 'content']
        );

        const error = validateToolArgs('write_file', {}, s);

        expect(error).toContain('issues');
        expect(error).toContain('`path` is missing');
        expect(error).toContain('`content` is missing');
    });

    // ==================== 类型不匹配 ====================

    it('类型不匹配时返回可读错误', () => {
        const s = schema(
            { timeout: { type: 'number' } },
            ['timeout']
        );

        const error = validateToolArgs('execute_command', { timeout: 'abc' }, s);

        expect(error).not.toBeNull();
        expect(error).toContain('`timeout`');
        expect(error).toContain('expected as `number`');
        expect(error).toContain('provided as `string`');
    });

    it('期望 array 但收到 object 时报错', () => {
        const s = schema(
            { files: { type: 'array' } },
            ['files']
        );

        const error = validateToolArgs('write_file', { files: { path: 'a.txt' } }, s);

        expect(error).toContain('expected as `array`');
        expect(error).toContain('provided as `object`');
    });

    it('期望 boolean 但收到 string 时报错', () => {
        const s = schema(
            { recursive: { type: 'boolean' } },
            ['recursive']
        );

        // 注意：此测试假设已经过了 coerceToolArgs，
        // "yes" 不会被 coerceToolArgs 转换，所以到达此处仍然是 string
        const error = validateToolArgs('list_files', { recursive: 'yes' }, s);

        expect(error).toContain('expected as `boolean`');
        expect(error).toContain('provided as `string`');
    });

    it('integer 类型收到浮点数时报错', () => {
        const s = schema(
            { line: { type: 'integer' } },
            ['line']
        );

        const error = validateToolArgs('insert_code', { line: 3.14 }, s);

        expect(error).toContain('expected as `integer`');
    });

    it('integer 类型收到整数时通过', () => {
        const s = schema(
            { line: { type: 'integer' } },
            ['line']
        );

        expect(validateToolArgs('insert_code', { line: 5 }, s)).toBeNull();
    });

    // ==================== 多余字段 ====================

    it('schema 中未定义的参数不再导致报错（由 normalizeToolArgs 剥离+警告）', () => {
        const s = schema(
            { path: { type: 'string' } },
            ['path']
        );

        expect(validateToolArgs('read_file', { path: 'a.txt', nonexistent: 123 }, s)).toBeNull();
    });

    // ==================== array 参数的详细指引 ====================

    it('array 参数收到无法解析的字符串时给出具体指引', () => {
        const s = schema(
            { files: { type: 'array' } },
            ['files']
        );

        const error = validateToolArgs('write_file', { files: '{"path":"a.txt"}' }, s);

        expect(error).not.toBeNull();
        expect(error).toContain('`files`');
        expect(error).toContain('could not be parsed into a JSON array');
    });

    // ==================== 混合场景 ====================

    it('同时存在多种错误时全部列出', () => {
        const s = schema(
            {
                path: { type: 'string' },
                line: { type: 'number' }
            },
            ['path', 'line']
        );

        // 缺少 path，line 类型错
        const error = validateToolArgs('insert_code', { line: 'abc' }, s);

        expect(error).not.toBeNull();
        expect(error).toContain('`path` is missing');
        expect(error).toContain('`line`');
        expect(error).toContain('expected as `number`');
    });

    // ==================== 边界情况 ====================

    it('可选参数缺失时不报错', () => {
        const s = schema(
            {
                path: { type: 'string' },
                encoding: { type: 'string' }
            },
            ['path']  // encoding 不在 required 中
        );

        expect(validateToolArgs('read_file', { path: 'a.txt' }, s)).toBeNull();
    });

    it('参数值为 null 时跳过类型检查', () => {
        const s = schema(
            { path: { type: 'string' } },
            []
        );

        expect(validateToolArgs('read_file', { path: null }, s)).toBeNull();
    });

    it('schema 没有 required 字段时不检查必需性', () => {
        const s = schema(
            { path: { type: 'string' } }
            // 没有 required
        );

        expect(validateToolArgs('read_file', {}, s)).toBeNull();
    });

    // ==================== 嵌套结构递归校验 ====================

    it('数组元素缺少必需字段时报出带路径的错误', () => {
        const s = schema(
            {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            line: { type: 'number' },
                            content: { type: 'string' }
                        },
                        required: ['path', 'line', 'content']
                    }
                }
            },
            ['files']
        );

        const error = validateToolArgs('insert_code', {
            files: [{ path: 'a.ts', content: 'x' }]
        }, s);

        expect(error).toContain('The required parameter `files[0].line` is missing');
    });

    it('数组元素字段类型不匹配时报出带路径的错误', () => {
        const s = schema(
            {
                hunks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            oldContent: { type: 'string' },
                            newContent: { type: 'string' },
                            startLine: { type: 'number' }
                        },
                        required: ['oldContent', 'newContent']
                    }
                }
            },
            ['hunks']
        );

        const error = validateToolArgs('apply_diff', {
            hunks: [
                { oldContent: 'a', newContent: 'b' },
                { oldContent: 'a', newContent: 'b', startLine: { line: 3 } }
            ]
        }, s);

        expect(error).toContain('`hunks[1].startLine`');
        expect(error).toContain('expected as `number`');
    });

    it('嵌套 object 的必需字段缺失时报出带路径的错误', () => {
        const s = schema(
            {
                sourceArtifact: {
                    type: 'object',
                    properties: {
                        type: { type: 'string' },
                        path: { type: 'string' }
                    },
                    required: ['type', 'path']
                }
            },
            []
        );

        const error = validateToolArgs('create_plan', {
            sourceArtifact: { type: 'design' }
        }, s);

        expect(error).toContain('The required parameter `sourceArtifact.path` is missing');
    });

    it('嵌套结构完全正确时通过', () => {
        const s = schema(
            {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            line: { type: 'number' },
                            content: { type: 'string' }
                        },
                        required: ['path', 'line', 'content']
                    }
                }
            },
            ['files']
        );

        expect(validateToolArgs('insert_code', {
            files: [{ path: 'a.ts', line: 1, content: 'x' }]
        }, s)).toBeNull();
    });

    it('类型错误的值不再深入检查（避免误导性的连锁错误）', () => {
        const s = schema(
            {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path']
                    }
                }
            },
            ['files']
        );

        // files 是 object 而非 array：只报顶层类型错误，不报 files[0].path missing
        const error = validateToolArgs('write_file', { files: { path: 'a' } }, s) as string;

        expect(error).toContain('expected as `array`');
        expect(error).not.toContain('files[0]');
    });

    // ==================== enum 校验 ====================

    it('enum 值不合法时报错并列出全部可选值', () => {
        const s = schema(
            { updateMode: { type: 'string', enum: ['revision', 'progress_sync'] } },
            []
        );

        const error = validateToolArgs('update_plan', { updateMode: 'rewrite' }, s);

        expect(error).toContain('`updateMode`');
        expect(error).toContain('"revision" | "progress_sync"');
        expect(error).toContain('`rewrite`');
    });

    it('嵌套数组元素的 enum 值不合法时报出带路径的错误', () => {
        const s = schema(
            {
                todos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
                        },
                        required: ['id', 'status']
                    }
                }
            },
            ['todos']
        );

        const error = validateToolArgs('todo_write', {
            todos: [{ id: '1', status: 'done' }]
        }, s);

        expect(error).toContain('`todos[0].status`');
        expect(error).toContain('"pending"');
        expect(error).toContain('`done`');
    });

    it('enum 值合法时通过', () => {
        const s = schema(
            { updateMode: { type: 'string', enum: ['revision', 'progress_sync'] } },
            []
        );

        expect(validateToolArgs('update_plan', { updateMode: 'revision' }, s)).toBeNull();
    });

    // ==================== 参数签名回显 ====================

    it('校验失败时附带 Expected parameters 参数签名', () => {
        const s = schema(
            {
                path: { type: 'string' },
                startLine: { type: 'integer' }
            },
            ['path']
        );

        const error = validateToolArgs('read_file', {}, s);

        expect(error).toContain('Expected parameters for `read_file`:');
        expect(error).toContain('- path: string (required)');
        expect(error).toContain('- startLine: integer (optional)');
    });

    it('签名内联展开嵌套数组元素形状与 enum 联合', () => {
        const s = schema(
            {
                todos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            status: { type: 'string', enum: ['pending', 'completed'] }
                        },
                        required: ['id', 'status']
                    }
                }
            },
            ['todos']
        );

        const error = validateToolArgs('todo_write', {}, s);

        expect(error).toContain('todos: Array<{ id: string; status: "pending" | "completed" }> (required)');
    });

    it('问题条数过多时截断并提示剩余数量', () => {
        const s = schema(
            {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            line: { type: 'number' },
                            content: { type: 'string' }
                        },
                        required: ['path', 'line', 'content']
                    }
                }
            },
            ['files']
        );

        // 12 个空元素 × 3 个缺失字段 = 36 条问题，应只报告前 10 条 + 1 条截断提示
        const files = Array.from({ length: 12 }, () => ({}));
        const error = validateToolArgs('insert_code', { files }, s) as string;

        expect(error).toContain('more similar issues');
        const reportedLines = error.split('\n\nExpected parameters')[0].split('\n').slice(1);
        expect(reportedLines).toHaveLength(11);
    });
});
