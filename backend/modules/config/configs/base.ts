import { deepMerge, isSafeMergeKey } from '../../../core/deepMerge';
import type { BaseChannelConfig, CustomBodyConfig } from '../../../../packages/contracts/src/channels/base';
export * from '../../../../packages/contracts/src/channels/base';
export { deepMerge };


/**
 * 解析自定义 body 配置并与原始 body 合并
 *
 * @param originalBody 原始请求体
 * @param customBody 自定义 body 配置
 * @param enabled 是否启用
 * @returns 合并后的请求体
 */
export function applyCustomBody(originalBody: any, customBody?: CustomBodyConfig, enabled?: boolean): any {
    if (!enabled || !customBody) {
        return originalBody;
    }
    
    let result = { ...originalBody };
    
    if (customBody.mode === 'simple' && customBody.items) {
        // 简单模式：遍历所有项
        for (const item of customBody.items) {
            if (!item.enabled || !item.key || !item.key.trim()) {
                continue;
            }
            
            const rawKey = item.key.trim();
            let value: any;
            
            // 尝试解析值为 JSON
            try {
                value = JSON.parse(item.value);
            } catch {
                // 解析失败，使用原始字符串
                value = item.value;
            }
            
            // 处理嵌套路径键名（如 "extra_body.google"）
            if (rawKey.includes('.')) {
                const parts = rawKey.split('.');
                const nestedObj = {};
                let current: any = nestedObj;
                for (let i = 0; i < parts.length - 1; i++) {
                    // 跳过 __proto__/constructor/prototype 段，防止 current[key]= 触发原型 setter
                    if (!isSafeMergeKey(parts[i])) {
                        continue;
                    }
                    current[parts[i]] = {};
                    current = current[parts[i]];
                }
                const lastKey = parts[parts.length - 1];
                if (isSafeMergeKey(lastKey)) {
                    current[lastKey] = value;
                }
                result = deepMerge(result, nestedObj);
            } else {
                result = deepMerge(result, { [rawKey]: value });
            }
        }
    } else if (customBody.mode === 'advanced' && customBody.json) {
        // 复杂模式：解析完整 JSON 并深度合并
        try {
            const customData = JSON.parse(customBody.json);
            // 校验解析结果：只接受纯对象。数组/原始值（如 "123"、"[1,2]"）无法作为
            // 请求体字段合并，deepMerge 对非对象值直接覆盖会整体替换 originalBody，
            // 破坏请求体结构；非纯对象时告警并跳过本次合并
            if (customData === null || typeof customData !== 'object' || Array.isArray(customData)) {
                console.warn('Failed to apply custom body JSON: expected a JSON object, got:', typeof customData);
                return result;
            }
            result = deepMerge(result, customData);
        } catch (error) {
            console.warn('Failed to parse custom body JSON:', error);
        }
    }
    
    return result;
}

/** Resolve transport and payload streaming from the same effective configuration. */
export function resolveConfiguredStream(config: BaseChannelConfig & { options?: { stream?: boolean } }): boolean {
    const configured = config.options?.stream ?? config.preferStream ?? false;
    // generateContent chooses its transport in the URL, not a body.stream field.
    if (config.type === 'gemini') return configured;
    const stream = applyCustomBody({ stream: configured }, config.customBody, config.customBodyEnabled).stream;
    if (typeof stream !== 'boolean') throw new TypeError('customBody.stream must be a boolean');
    return stream;
}
