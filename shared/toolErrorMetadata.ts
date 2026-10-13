export interface ToolErrorDisplayMetadata {
  /** 界面解释文件错误时使用；在模型请求边界移除，不属于工具正文。 */
  displayErrorCode?: string;
}

export function getErrorDisplayMetadata(error: unknown): ToolErrorDisplayMetadata {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { displayErrorCode: code } : {};
}

function withoutErrorCode(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, 'displayErrorCode')) return value;
  const { displayErrorCode: _displayErrorCode, ...rest } = value;
  return rest;
}

/** 只处理正式回执的顶层、data 与 data.results，不递归改写用户返回的内容。 */
export function withoutToolErrorDisplayMetadata(response: Record<string, unknown>): Record<string, unknown> {
  const clean = withoutErrorCode(response);
  const originalData = response.data;
  if (!originalData || typeof originalData !== 'object' || Array.isArray(originalData)) return clean;
  let data = withoutErrorCode(originalData as Record<string, unknown>);
  const results = data.results;
  if (Array.isArray(results) && results.some(item => item && typeof item === 'object' && Object.hasOwn(item, 'displayErrorCode'))) {
    data = { ...data, results: results.map(item => item && typeof item === 'object' && !Array.isArray(item)
      ? withoutErrorCode(item as Record<string, unknown>) : item) };
  }
  return data === originalData ? clean : { ...clean, data };
}
