import type { RuntimeTool } from '@graycode/core';
import { ToolSchemaValidators } from '../../../../packages/core/src/runtime/toolSchemaValidation';

interface BatchItemResult {
  index?: number;
  path?: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * 只用于原本就逐项执行并返回 data.results 的工具。入口保留数组与顶层约束，
 * 条目仍按同一份 schema 校验；有效项按原顺序交给原执行器，结果映射回原始位置。
 */
export function withBatchItems(tool: RuntimeTool, field: string, options: {
  exclusiveWith?: string;
  allowPartialSuccess?: boolean;
} = {}): RuntimeTool {
  const parameters = tool.validationSchema ?? tool.declaration.parameters;
  const properties = parameters.properties as Record<string, Record<string, unknown>>;
  const arraySchema = properties[field];
  const compiled = new ToolSchemaValidators().compile(arraySchema.items as Record<string, unknown>);
  return {
    ...tool,
    validationSchema: { ...parameters, properties: { ...properties, [field]: { ...arraySchema, items: {} } } },
    execute: async (args, context) => {
      const input = args[field];
      const exclusive = options.exclusiveWith ? args[options.exclusiveWith] : undefined;
      // 单项形式及互斥参数的报错仍由原执行器处理，不能因为过滤失败项而改变操作模式。
      if (!Array.isArray(input) || !input.length || typeof exclusive === 'string' && exclusive.trim()) {
        return tool.execute(args, context);
      }
      const accepted: unknown[] = [], indices: number[] = [], rejected: BatchItemResult[] = [];
      input.forEach((value, index) => {
        const normalized = value && typeof value === 'object' && !Array.isArray(value)
          ? compiled.normalizeArguments(value as Record<string, unknown>) : value;
        if (compiled.validate(normalized)) {
          accepted.push(normalized);
          indices.push(index);
        } else {
          const error = compiled.validate.errors![0];
          rejected.push({ index, path: typeof value === 'string' ? value : typeof value?.path === 'string' ? value.path : '',
            success: false, error: `${field}[${index}]${error.instancePath} ${error.message} ${JSON.stringify(error.params)}` });
        }
      });
      const result = accepted.length || options.allowPartialSuccess
        ? await tool.execute({ ...args, [field]: accepted }, context)
        : { success: false, data: { results: [] } };
      const data = result.data as { results?: BatchItemResult[]; [key: string]: unknown } | undefined;
      if (!Array.isArray(data?.results)) {
        return rejected.length ? { ...result, data: { ...data, validationErrors: rejected } } : result;
      }
      const results = [...data.results.map((item, index) => ({ ...item, index: indices[item.index ?? index] })), ...rejected]
        .sort((a, b) => a.index! - b.index!);
      const successCount = results.filter(item => item.success).length;
      const failCount = results.filter(item => !item.success && !item.skipped).length;
      const skippedCount = results.filter(item => item.skipped).length;
      const partial = successCount > 0 && (failCount > 0 || skippedCount > 0);
      const success = options.allowPartialSuccess ? successCount > 0 : result.success && !rejected.length;
      return {
        ...result,
        success,
        ...(rejected.length && !success ? { error: `${failCount} 个条目未完成，请按 results 中的 index 修正失败项。` } : {}),
        data: {
          ...data, results, successCount, failCount, partial,
          totalCount: typeof data.totalCount === 'number' ? data.totalCount + rejected.length : input.length,
          ...('requestedCount' in data ? { requestedCount: input.length } : {}),
          ...('processedCount' in data ? { processedCount: Number(data.processedCount) + rejected.length } : {}),
          ...('appliedOps' in data ? { appliedOps: successCount, invalidOps: Number(data.invalidOps) + rejected.length } : {}),
          ...('appliedCount' in data ? { failedCount: failCount, diffCount: input.length } : {}),
          ...(Array.isArray(data.failedPaths) ? { failedPaths: [...data.failedPaths, ...rejected.map(item => item.path).filter(Boolean)] } : {}),
        },
      };
    },
  };
}
