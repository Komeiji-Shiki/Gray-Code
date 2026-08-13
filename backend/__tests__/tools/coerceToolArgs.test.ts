import {
    coerceToolArgs,
    normalizeToolArgs
} from '../../tools/coerceToolArgs';
import type { PropertySchema } from '../../tools/toolSchema';

function schema(properties: Record<string, PropertySchema>, required?: string[]) {
    return { type: 'object' as const, properties, required };
}

describe('coerceToolArgs', () => {
    // ==================== 基础守卫 ====================

    test('在没有 schema 时保持原值', () => {
        const args = { files: '[{"path":"a.txt"}]' };

        expect(coerceToolArgs(args, undefined as any)).toBe(args);
    });

    // ==================== array 容错 ====================

    test('对已经是数组的参数不做处理', () => {
        const args = { files: [{ path: 'a.txt', content: 'hello' }] };
        const s = schema({
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        content: { type: 'string' }
                    }
                }
            }
        });

        expect(coerceToolArgs(args, s)).toBe(args);
    });

    test('顶层 array 参数收到字符串时尝试解析为数组', () => {
        const args = { files: '[{"path":"a.txt","content":"hello"}]' };
        const s = schema({
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        content: { type: 'string' }
                    }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        expect(result).toEqual({
            files: [{ path: 'a.txt', content: 'hello' }]
        });
        expect(Array.isArray(result.files)).toBe(true);
    });

    test('递归修正数组元素内部的字段类型', () => {
        const args = {
            files: '[{"path":"a.txt","startLine":"10","endLine":"20"}]'
        };
        const s = schema({
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        startLine: { type: 'number' },
                        endLine: { type: 'number' }
                    }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        // 数组内部的 "10"、"20" 会被递归转为数字
        expect(result.files).toEqual([
            {
                path: 'a.txt',
                startLine: 10,
                endLine: 20
            }
        ]);
    });

    test('递归修正已是数组的参数中嵌套的类型错误', () => {
        const args = {
            files: [{ path: 'a.txt', line: '5' }]
        };
        const s = schema({
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        line: { type: 'number' }
                    }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        expect(result.files).toEqual([{ path: 'a.txt', line: 5 }]);
    });

    test('递归修正嵌套 object 属性的类型错误', () => {
        const args = {
            options: { recursive: 'true', depth: '3' }
        };
        const s = schema({
            options: {
                type: 'object',
                properties: {
                    recursive: { type: 'boolean' },
                    depth: { type: 'number' }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        expect(result.options).toEqual({ recursive: true, depth: 3 });
    });

    test('不递归解析双层字符串数组', () => {
        const single = JSON.stringify([{ path: 'a.txt', content: 'hello' }]);
        const double = JSON.stringify(single);
        const args = { files: double };
        const s = schema({
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        content: { type: 'string' }
                    }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        // 双层字符串解析出来是 string 而非 array，不替换
        expect(result).toBe(args);
        expect(result.files).toBe(double);
    });

    test('object 参数收到 JSON 字符串时解析为对象（双重编码容错）', () => {
        const args = { config: '{"key":"foo","value":"bar"}' };
        const s = schema({
            config: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                    value: { type: 'string' }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        expect(result.config).toEqual({ key: 'foo', value: 'bar' });
    });

    test('object 参数的 JSON 字符串解析后继续递归修正类型', () => {
        const args = { options: '{"recursive":"true","depth":"3"}' };
        const s = schema({
            options: {
                type: 'object',
                properties: {
                    recursive: { type: 'boolean' },
                    depth: { type: 'number' }
                }
            }
        });

        const result = coerceToolArgs(args, s);

        expect(result.options).toEqual({ recursive: true, depth: 3 });
    });

    test('object 参数收到无法解析或非对象的字符串时保持原样', () => {
        const s = schema({
            config: { type: 'object', properties: { key: { type: 'string' } } }
        });

        expect(coerceToolArgs({ config: 'not json' }, s)).toEqual({ config: 'not json' });
        expect(coerceToolArgs({ config: '[1,2]' }, s)).toEqual({ config: '[1,2]' });
    });

    // ==================== boolean 容错 ====================

    test('将 "true" 字符串转为 true', () => {
        const args = { recursive: 'true' };
        const s = schema({ recursive: { type: 'boolean' } });

        const result = coerceToolArgs(args, s);

        expect(result.recursive).toBe(true);
        expect(typeof result.recursive).toBe('boolean');
    });

    test('将 "false" 字符串转为 false', () => {
        const args = { recursive: 'false' };
        const s = schema({ recursive: { type: 'boolean' } });

        const result = coerceToolArgs(args, s);

        expect(result.recursive).toBe(false);
        expect(typeof result.recursive).toBe('boolean');
    });

    test('兼容 Python 风格的 "True"/"False"', () => {
        const s = schema({ recursive: { type: 'boolean' } });

        expect(coerceToolArgs({ recursive: 'True' }, s).recursive).toBe(true);
        expect(coerceToolArgs({ recursive: 'False' }, s).recursive).toBe(false);
        expect(coerceToolArgs({ recursive: 'TRUE' }, s).recursive).toBe(true);
    });

    test('对已经是 boolean 的值不做处理', () => {
        const args = { recursive: true };
        const s = schema({ recursive: { type: 'boolean' } });

        // 未修改时返回原始对象引用
        expect(coerceToolArgs(args, s)).toBe(args);
    });

    test('不转换非 "true"/"false" 的 boolean 字符串（如 "yes"、"1"）', () => {
        const args = { recursive: 'yes' };
        const s = schema({ recursive: { type: 'boolean' } });

        // "yes" 不是精确匹配，保持原值不动
        const result = coerceToolArgs(args, s);
        expect(result.recursive).toBe('yes');
    });

    // ==================== number 容错 ====================

    test('将 "60000" 字符串转为 60000', () => {
        const args = { timeout: '60000' };
        const s = schema({ timeout: { type: 'number' } });

        const result = coerceToolArgs(args, s);

        expect(result.timeout).toBe(60000);
        expect(typeof result.timeout).toBe('number');
    });

    test('将 "-5" 字符串转为 -5', () => {
        const args = { offset: '-5' };
        const s = schema({ offset: { type: 'number' } });

        const result = coerceToolArgs(args, s);

        expect(result.offset).toBe(-5);
    });

    test('将 "3.14" 字符串转为 3.14', () => {
        const args = { ratio: '3.14' };
        const s = schema({ ratio: { type: 'number' } });

        const result = coerceToolArgs(args, s);

        expect(result.ratio).toBe(3.14);
    });

    test('对 integer 类型同样生效', () => {
        const args = { count: '42' };
        const s = schema({ count: { type: 'integer' } });

        const result = coerceToolArgs(args, s);

        expect(result.count).toBe(42);
    });

    test('对已经是 number 的值不做处理', () => {
        const args = { timeout: 60000 };
        const s = schema({ timeout: { type: 'number' } });

        expect(coerceToolArgs(args, s)).toBe(args);
    });

    test('不转换非法数字字符串（如 "abc"、"12px"）', () => {
        const args = { timeout: '12px' };
        const s = schema({ timeout: { type: 'number' } });

        const result = coerceToolArgs(args, s);
        expect(result.timeout).toBe('12px');
    });

    test('不转换空字符串', () => {
        const args = { timeout: '' };
        const s = schema({ timeout: { type: 'number' } });

        const result = coerceToolArgs(args, s);
        expect(result.timeout).toBe('');
    });

    // ==================== 混合场景 ====================

    test('同时处理多个不同类型的参数', () => {
        const args = {
            recursive: 'true',
            timeout: '60000',
            files: '[{"path":"a.txt"}]',
            query: 'hello'  // string 类型，不应被转换
        };
        const s = schema({
            recursive: { type: 'boolean' },
            timeout: { type: 'number' },
            files: {
                type: 'array',
                items: { type: 'object', properties: { path: { type: 'string' } } }
            },
            query: { type: 'string' }
        });

        const result = coerceToolArgs(args, s);

        expect(result.recursive).toBe(true);
        expect(result.timeout).toBe(60000);
        expect(result.files).toEqual([{ path: 'a.txt' }]);
        expect(result.query).toBe('hello');
    });

    test('所有值都已是正确类型时返回原始对象引用', () => {
        const args = {
            recursive: true,
            timeout: 60000,
            query: 'hello'
        };
        const s = schema({
            recursive: { type: 'boolean' },
            timeout: { type: 'number' },
            query: { type: 'string' }
        });

        // 没有任何修改，返回同一个引用
        expect(coerceToolArgs(args, s)).toBe(args);
    });
});

describe('normalizeToolArgs', () => {
    // ==================== 单数别名提升 ====================

    test('将 path（字符串）提升为 paths（数组）并生成警告', () => {
        const s = schema({
            paths: { type: 'array', items: { type: 'string' } }
        }, ['paths']);

        const { args, warnings } = normalizeToolArgs('read_file', { path: 'a.txt' } as any, s);

        expect(args).toEqual({ paths: ['a.txt'] });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('`path`');
        expect(warnings[0]).toContain('`paths`');
    });

    test('单数别名的值已是数组时仅改名', () => {
        const s = schema({
            patterns: { type: 'array', items: { type: 'string' } }
        }, ['patterns']);

        const { args, warnings } = normalizeToolArgs('find_files', { pattern: ['*.ts'] } as any, s);

        expect(args).toEqual({ patterns: ['*.ts'] });
        expect(warnings).toHaveLength(1);
    });

    test('单数名本身是合法参数时不做提升', () => {
        // 模拟 search_in_files：path 和 pattern 都是真实参数
        const s = schema({
            query: { type: 'string' },
            path: { type: 'string' },
            pattern: { type: 'string' }
        }, ['query']);

        const input = { query: 'foo', path: 'src/' };
        const { args, warnings } = normalizeToolArgs('search_in_files', input, s);

        expect(args).toEqual(input);
        expect(warnings).toHaveLength(0);
    });

    test('复数参数已提供时不理会单数别名（单数键会被当作未知参数剥离）', () => {
        const s = schema({
            paths: { type: 'array', items: { type: 'string' } }
        }, ['paths']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { paths: ['a.txt'], path: 'b.txt' } as any,
            s
        );

        expect(args).toEqual({ paths: ['a.txt'] });
        expect(warnings.some(w => w.includes('Ignored unexpected parameter'))).toBe(true);
    });

    // ==================== 未知参数剥离 ====================

    test('剥离 schema 中未声明的参数并生成警告，而不是失败', () => {
        const s = schema({ path: { type: 'string' } }, ['path']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { path: 'a.txt', nonexistent: 123 },
            s
        );

        expect(args).toEqual({ path: 'a.txt' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('`nonexistent`');
        expect(warnings[0]).toContain('read_file');
    });

    test('剥离 update_plan 的 carry-over 字段（通用规则覆盖原硬编码特例）', () => {
        const s = schema({
            path: { type: 'string' },
            todos: { type: 'array', items: { type: 'object' } }
        }, ['path', 'todos']);

        const { args, warnings } = normalizeToolArgs(
            'update_plan',
            {
                path: '.graycode/plans/x.md',
                todos: [],
                sourceArtifactType: 'design',
                planContent: '...',
                continuationPrompt: 'go on'
            },
            s
        );

        expect(args).toEqual({ path: '.graycode/plans/x.md', todos: [] });
        expect(warnings).toHaveLength(3);
    });

    // ==================== 组合行为 ====================

    test('别名提升 + 类型容错 + 未知参数剥离可以在一次调用中同时发生', () => {
        const s = schema({
            paths: { type: 'array', items: { type: 'string' } },
            recursive: { type: 'boolean' }
        }, ['paths']);

        const { args, warnings } = normalizeToolArgs(
            'list_files',
            { path: 'src', recursive: 'true', verbose: 1 } as any,
            s
        );

        expect(args).toEqual({ paths: ['src'], recursive: true });
        expect(warnings).toHaveLength(2);
    });

    test('无需任何纠正时返回原始引用且无警告', () => {
        const s = schema({
            paths: { type: 'array', items: { type: 'string' } }
        }, ['paths']);

        const input = { paths: ['a.txt'] };
        const { args, warnings } = normalizeToolArgs('read_file', input, s);

        expect(args).toBe(input);
        expect(warnings).toHaveLength(0);
    });

    test('没有 schema 时原样返回', () => {
        const input = { anything: 1 };
        const { args, warnings } = normalizeToolArgs('unknown_tool', input, undefined);

        expect(args).toBe(input);
        expect(warnings).toHaveLength(0);
    });

    // ==================== ies 复数的单数提升 ====================

    test('支持 ies 复数：query 提升为 queries', () => {
        const s = schema({
            queries: { type: 'array', items: { type: 'string' } }
        }, ['queries']);

        const { args, warnings } = normalizeToolArgs('batch_search', { query: 'foo' } as any, s);

        expect(args).toEqual({ queries: ['foo'] });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('`query`');
        expect(warnings[0]).toContain('`queries`');
    });

    // ==================== paramAliases 参数改名 ====================

    test('paramAliases：别名自动改名为规范参数并生成警告', () => {
        const s = schema({
            path: { type: 'string' },
            endLine: { type: 'integer' }
        }, ['path']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { path: 'a.txt', maxLine: 30 },
            s,
            { paramAliases: { maxLine: 'endLine' } }
        );

        expect(args).toEqual({ path: 'a.txt', endLine: 30 });
        expect(warnings.some(w => w.includes('`maxLine`') && w.includes('`endLine`'))).toBe(true);
    });

    test('paramAliases：规范参数已提供时丢弃别名并警告', () => {
        const s = schema({
            path: { type: 'string' },
            endLine: { type: 'integer' }
        }, ['path']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { path: 'a.txt', endLine: 10, maxLine: 30 },
            s,
            { paramAliases: { maxLine: 'endLine' } }
        );

        expect(args).toEqual({ path: 'a.txt', endLine: 10 });
        expect(warnings.some(w => w.includes('Ignored parameter `maxLine`'))).toBe(true);
    });

    test('paramAliases：别名与 schema 真实参数同名时不处理（防御声明错误）', () => {
        const s = schema({
            path: { type: 'string' },
            line: { type: 'integer' }
        }, ['path']);

        const input = { path: 'a.txt', line: 5 };
        const { args, warnings } = normalizeToolArgs(
            'read_file', input, s,
            { paramAliases: { line: 'path' } }
        );

        expect(args).toEqual(input);
        expect(warnings).toHaveLength(0);
    });

    // ==================== compatParams 兼容透传 ====================

    test('compatParams：兼容参数不被剥离并附温和提示', () => {
        const s = schema({
            path: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' }
        }, ['path']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { path: 'a.txt', limit: 100 },
            s,
            { compatParams: ['line', 'maxLines', 'limit'] }
        );

        expect(args).toEqual({ path: 'a.txt', limit: 100 });
        expect(warnings.some(w => w.includes('`limit`') && w.includes('compatibility'))).toBe(true);
    });

    test('compatParams 之外的未知参数仍然剥离', () => {
        const s = schema({ path: { type: 'string' } }, ['path']);

        const { args, warnings } = normalizeToolArgs(
            'read_file',
            { path: 'a.txt', limit: 100, bogus: 1 },
            s,
            { compatParams: ['limit'] }
        );

        expect(args).toEqual({ path: 'a.txt', limit: 100 });
        expect(warnings.some(w => w.includes('Ignored unexpected parameter `bogus`'))).toBe(true);
    });
});
