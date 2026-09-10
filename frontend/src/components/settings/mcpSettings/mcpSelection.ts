import type { Attachment } from '../../../types';
import type { PromptContextItem } from '../../../types/promptContext';
import type { McpPromptMessage, McpResourceContent } from './mcpBrowse';

interface Selection { context: PromptContextItem; attachments: Attachment[] }
function attachment(data: string, mimeType: string, name: string): Attachment {
  const bytes = atob(data);
  return { id: crypto.randomUUID(), name, data, mimeType, size: bytes.length,
    ...(/^(image|audio|video)\//.test(mimeType) ? { url: `data:${mimeType};base64,${data}` } : {}),
    type: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('video/') ? 'video' : 'document' };
}
function selection(title: string, content: string, attachments: Attachment[]): Selection {
  return { context: { id: crypto.randomUUID(), type: 'text', title, content, enabled: true, addedAt: Date.now() }, attachments };
}
function resourceParts(content: McpResourceContent, texts: string[], attachments: Attachment[], label = ''): void {
  if (typeof content.text === 'string') texts.push(`${label}${content.uri}\n${content.text}`);
  if (typeof content.blob === 'string') {
    const name = content.uri.split('/').at(-1) || 'MCP 资源';
    attachments.push(attachment(content.blob, content.mimeType ?? 'application/octet-stream', name));
    texts.push(`${label}${content.uri}\n附件：${name}`);
  }
}
export function selectMcpResource(serverName: string, value: McpResourceContent): Selection {
  const texts: string[] = []; const attachments: Attachment[] = [];
  for (const content of value.contents ?? [value]) resourceParts(content, texts, attachments);
  return selection(`MCP 资源 · ${serverName}`, texts.join('\n\n'), attachments);
}
export function selectMcpPrompt(serverName: string, name: string, messages: McpPromptMessage[]): Selection {
  const texts: string[] = []; const attachments: Attachment[] = [];
  for (const message of messages) {
    const content = message.content; const label = `[${message.role}]\n`;
    if (content.type === 'resource' && content.resource) resourceParts(content.resource, texts, attachments, label);
    else if (typeof content.data === 'string') {
      const mime = content.mimeType ?? (content.type === 'image' ? 'image/png' : 'application/octet-stream');
      const name = `${message.role}-${attachments.length + 1}`;
      attachments.push(attachment(content.data, mime, name)); texts.push(`${label}附件：${name}`);
    } else if (typeof content.text === 'string') texts.push(label + content.text);
    else if (content.type === 'resource_link') texts.push(label + (content.uri ?? ''));
    else { const { _meta, ...visible } = content; texts.push(label + JSON.stringify(visible, null, 2)); }
  }
  // 模板角色作为引用内容保留；实际消息仍由用户在输入框确认发送。
  return selection(`MCP 提示 · ${serverName} / ${name}`, texts.join('\n\n'), attachments);
}
