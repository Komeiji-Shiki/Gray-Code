export interface PromptPreviewResult {
  protocol: string;
  model: string;
  body: unknown;
  createdAt: number;
  estimatedTokens: number;
  notices: string[];
  character?: { resources: unknown; activation: unknown };
}

/** 已发送请求和发送前预览共用协议分组，顺序完全服从格式器正文。 */
export function requestGroups(body: unknown): { title: string; value: unknown }[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ title: '请求正文', value: body }];
  const groups: { title: string; value: unknown }[] = [];
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (['messages', 'contents', 'input'].includes(key) && Array.isArray(value)) {
      value.forEach((message, index) => groups.push({ title: `${key} · ${index + 1} · ${message?.role ?? message?.type ?? '内容'}`, value: message }));
    } else if (['system', 'systemInstruction', 'instructions', 'tools', 'toolConfig'].includes(key)) {
      groups.push({ title: key, value });
    } else options[key] = value;
  }
  if (Object.keys(options).length) groups.push({ title: '模型参数与其他字段', value: options });
  return groups;
}

/** 阅读视图展开文字换行；二进制附件在完整 JSON 中保留。 */
export function requestReadableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestReadableText).join('\n\n');
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value, null, 2) ?? '';
  const item = value as Record<string, any>;
  if (['tool_use', 'tool_result'].includes(item.type)) return JSON.stringify(value, null, 2);
  if (typeof item.text === 'string') return item.text;
  if (item.content !== undefined) return [
    item.reasoning_content ? `思考内容\n${item.reasoning_content}` : '', requestReadableText(item.content),
    item.tool_calls ? `工具调用\n${JSON.stringify(item.tool_calls, null, 2)}` : '',
    item.function_call ? `工具调用\n${JSON.stringify(item.function_call, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
  if (item.parts !== undefined) return requestReadableText(item.parts);
  if (item.type === 'image_url' || item.type === 'input_image') return '[图片附件，完整数据见 JSON]';
  if (item.inlineData || item.inline_data || item.source?.type === 'base64' || item.type === 'input_audio' || item.type === 'input_file') return '[多媒体附件，完整数据见 JSON]';
  return JSON.stringify(value, null, 2);
}
