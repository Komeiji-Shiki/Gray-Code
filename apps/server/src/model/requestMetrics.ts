import type { ModelRequestMetrics } from '@graycode/contracts';

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

/** 只遍历协议内容块，不解码图片，也不把工具参数里的同名字段当成图片输入。 */
function imageCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + imageCount(part), 0);
  const part = object(value);
  if (!part) return 0;
  if (part.type === 'image_url' && object(part.image_url)) return 1;
  if (part.type === 'input_image' && (typeof part.image_url === 'string' || typeof part.file_id === 'string')) return 1;
  if (part.type === 'image' && object(part.source)) return 1;
  const inline = object(part.inlineData ?? part.inline_data), file = object(part.fileData ?? part.file_data);
  const mimeType = inline?.mimeType ?? inline?.mime_type ?? file?.mimeType ?? file?.mime_type;
  if (typeof mimeType === 'string' && mimeType.startsWith('image/')) return 1;
  return imageCount(part.content ?? part.parts);
}

export function modelRequestMetrics(body: unknown): ModelRequestMetrics {
  const request = object(body) ?? {};
  const input = request.messages ?? request.input ?? request.contents;
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return {
    inputItems: Array.isArray(input) ? input.length : typeof input === 'string' ? 1 : 0,
    inputImages: imageCount(input),
    nativeTools: tools.reduce((total, value) => {
      const tool = object(value), declarations = tool?.functionDeclarations ?? tool?.function_declarations;
      return total + (Array.isArray(declarations) ? declarations.length : 1);
    }, 0),
  };
}
