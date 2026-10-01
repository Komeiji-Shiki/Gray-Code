/** ChatGPT 订阅授权只用于官方 Responses 路由，参数清理必须晚于自定义请求体合并。 */
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/#settings/Usage';

// 普通 API 模型支持的缓存策略选项仍可能被订阅模型拒绝，订阅请求沿用服务端缓存策略。
const unsupportedFields = [
  'background', 'conversation', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation',
  'multi_agent', 'prompt', 'prompt_cache_options', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
];

export function normalizeChatGPTBody(source: Record<string, any>): Record<string, any> {
  const body: Record<string, any> = { ...source, stream: true, store: false };
  for (const field of unsupportedFields) delete body[field];
  if (typeof body.input === 'string') body.input = [{ role: 'user', content: body.input }];
  if (Array.isArray(body.input)) body.input = body.input.map((item: any) => {
    if (item.role === 'system') return { ...item, role: 'developer' };
    if (item.type === 'function_call' && !item.namespace) return { ...item, namespace: 'graycode' };
    if (item.type === 'reasoning') {
      const { status, ...reasoning } = item;
      // 官方输入要求每个推理项带 summary，明文历史或自定义请求缺少摘要时保留为空数组。
      return { ...reasoning, summary: reasoning.summary ?? [] };
    }
    return item;
  });
  if (Array.isArray(body.tools)) {
    const local = body.tools.filter((tool: any) => tool.type === 'function' || tool.type === 'custom');
    body.tools = body.tools.filter((tool: any) => tool.type !== 'function' && tool.type !== 'custom');
    if (local.length) body.tools.unshift({ type: 'namespace', name: 'graycode', description: 'GrayCode tools', tools: local });
  }
  return body;
}

export function chatgptHeaders(source: Record<string, string>, token: string): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(authorization|x-api-key|api-key)$/i.test(key)));
  return { ...headers, Authorization: `Bearer ${token}` };
}
