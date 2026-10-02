/**
 * ensureStrictSchema：strict 工具模式下递归补齐 additionalProperties。
 * 元组形式的 items（draft-07）与 prefixItems（2020-12）是 schema 数组，必须保持数组并逐项处理。
 */

import { ensureStrictSchema } from '../../modules/channel/formatters/base';

describe('ensureStrictSchema - 数组元素 schema', () => {
    const object = { type: 'object', properties: { name: { type: 'string' } } };

    test('单个 items 对象仍逐层补齐', () => {
        expect(ensureStrictSchema({ type: 'array', items: object })).toEqual({
            type: 'array', items: { ...object, additionalProperties: false }
        });
    });

    test('元组 items 与 prefixItems 保持数组，元素对象补齐 additionalProperties', () => {
        const schema = {
            type: 'object',
            properties: {
                legacy: { type: 'array', items: [{ type: 'string' }, object], additionalItems: false },
                tuple: { type: 'array', prefixItems: [object, { type: 'number' }], items: false },
            },
        };
        const before = structuredClone(schema);
        const strict = ensureStrictSchema<Record<string, any>>(schema);
        expect(strict.properties.legacy.items).toEqual([{ type: 'string' }, { ...object, additionalProperties: false }]);
        expect(Array.isArray(strict.properties.legacy.items)).toBe(true);
        expect(strict.properties.tuple.prefixItems).toEqual([{ ...object, additionalProperties: false }, { type: 'number' }]);
        expect(strict.properties.tuple.items).toBe(false);
        expect(strict.additionalProperties).toBe(false);
        // 输入不被原地修改
        expect(schema).toEqual(before);
    });

    test('requireAllProperties 模式下元组元素同样按严格规则处理', () => {
        const strict = ensureStrictSchema<Record<string, any>>({
            type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'object', properties: { a: { type: 'string' } } }] } }, required: ['pair']
        }, true);
        expect(strict.properties.pair.prefixItems).toEqual([{
            type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['a'], additionalProperties: false
        }]);
    });
});
