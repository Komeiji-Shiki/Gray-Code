/**
 * Channel formatter 附件（inlineData）序列化回归测试
 *
 * 覆盖 OpenAI / Anthropic / OpenAI Responses 三个 formatter 对用户上传附件的转换：
 * - 图片附件：保持原有行为（image_url / image / input_image）
 * - 文本附件（如 txt）：必须解码为 text 块，不能当作图片发送
 *   （否则 OpenAI 兼容 API 会报 "unknown variant image_url, expected text"）
 * - PDF 附件：Anthropic 转 document 块；OpenAI 系转文本占位
 */

import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import type { OpenAIConfig, AnthropicConfig, OpenAIResponsesConfig } from '../../modules/config/types';
import type { Content, ContentPart } from '../../modules/conversation/types';

// ---------- 工具函数 ----------

function createOpenAIConfig(overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    return {
        id: 'openai-attachment-test',
        name: 'OpenAI Attachment Test',
        type: 'openai',
        enabled: true,
        url: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        ...overrides
    } as OpenAIConfig;
}

function createAnthropicConfig(overrides: Partial<AnthropicConfig> = {}): AnthropicConfig {
    return {
        id: 'anthropic-attachment-test',
        name: 'Anthropic Attachment Test',
        type: 'anthropic',
        enabled: true,
        url: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-4',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        ...overrides
    } as AnthropicConfig;
}

function createResponsesConfig(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
    return {
        id: 'openai-responses-attachment-test',
        name: 'OpenAI Responses Attachment Test',
        type: 'openai-responses',
        enabled: true,
        url: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5',
        preferStream: false,
        timeout: 30000,
        ...overrides
    } as OpenAIResponsesConfig;
}

function inlineDataPart(mimeType: string, data: string): ContentPart {
    return { inlineData: { mimeType, data } };
}

function historyWith(parts: ContentPart[]): Content[] {
    return [{ role: 'user', parts }];
}

// text/plain 附件内容 -> base64
const TXT_BASE64 = Buffer.from('Hello txt attachment', 'utf8').toString('base64');
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------- OpenAI Chat Completions ----------

describe('OpenAIFormatter 附件序列化', () => {
    const formatter = new OpenAIFormatter();

    it('将 txt 附件（text/plain）解码为 text 块，而不是 image_url', () => {
        const config = createOpenAIConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('text/plain', TXT_BASE64)])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage).toBeDefined();
        expect(Array.isArray(userMessage.content)).toBe(true);

        const types = userMessage.content.map((c: any) => c.type);
        expect(types).not.toContain('image_url');
        expect(userMessage.content).toContainEqual({
            type: 'text',
            text: '[附件内容]\n\nHello txt attachment'
        });
    });

    it('function_call 模式下 txt 附件同样解码为 text 块', () => {
        const config = createOpenAIConfig({ toolMode: 'function_call' });
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([
                inlineDataPart('text/plain', TXT_BASE64),
                { text: '请分析这个文件' }
            ])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'text',
            text: '[附件内容]\n\nHello txt attachment'
        });
        expect(userMessage.content).toContainEqual({ type: 'text', text: '请分析这个文件' });
        expect(userMessage.content.some((c: any) => c.type === 'image_url')).toBe(false);
    });

    it('图片附件仍然转换为 image_url（不回归）', () => {
        const config = createOpenAIConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('image/png', PNG_BASE64)])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG_BASE64}` }
        });
    });

    it('PDF 等不支持格式转为文本占位，而不是 image_url', () => {
        // 默认未开启 pdfAttachmentEnabled 时的保守行为
        const config = createOpenAIConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('application/pdf', 'JVBERi0xLjQ=')])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'text',
            text: '[附件 (application/pdf)：当前渠道不支持直接发送该格式]'
        });
        expect(userMessage.content.some((c: any) => c.type === 'image_url')).toBe(false);
    });

    it('开启 pdfAttachmentEnabled 后 PDF 附件以 file 内容块发送', () => {
        const config = createOpenAIConfig({ pdfAttachmentEnabled: true });
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('application/pdf', 'JVBERi0xLjQ=')])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'file',
            file: {
                filename: 'attachment.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0xLjQ='
            }
        });
        expect(userMessage.content.some((c: any) => c.type === 'image_url')).toBe(false);
    });

    it('xml 模式下开启 pdfAttachmentEnabled 后 PDF 同样以 file 内容块发送', () => {
        const config = createOpenAIConfig({ toolMode: 'xml', pdfAttachmentEnabled: true });
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('application/pdf', 'JVBERi0xLjQ=')])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content.some((c: any) => c.type === 'file')).toBe(true);
    });

    it('xml 模式下 txt 附件同样解码为 text 块', () => {
        const config = createOpenAIConfig({ toolMode: 'xml' });
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('text/plain', TXT_BASE64)])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'text',
            text: '[附件内容]\n\nHello txt attachment'
        });
        expect(userMessage.content.some((c: any) => c.type === 'image_url')).toBe(false);
    });
});

// ---------- Anthropic ----------

describe('AnthropicFormatter 附件序列化', () => {
    const formatter = new AnthropicFormatter();

    it('将 txt 附件（text/plain）解码为 text 块', () => {
        const config = createAnthropicConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('text/plain', TXT_BASE64)])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'text',
            text: '[附件内容]\n\nHello txt attachment'
        });
        expect(userMessage.content.some((c: any) => c.type === 'image')).toBe(false);
    });

    it('将 PDF 附件转换为 document 块', () => {
        const config = createAnthropicConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('application/pdf', 'JVBERi0xLjQ=')])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'document',
            source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'JVBERi0xLjQ='
            }
        });
    });

    it('图片附件仍然转换为 image 块（不回归）', () => {
        const config = createAnthropicConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('image/png', PNG_BASE64)])
        }, config);

        const userMessage = (request.body.messages as any[]).find((m: any) => m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: PNG_BASE64
            }
        });
    });
});

// ---------- OpenAI Responses ----------

describe('OpenAIResponsesFormatter 附件序列化', () => {
    const formatter = new OpenAIResponsesFormatter();

    it('将 txt 附件（text/plain）解码为 input_text 块', () => {
        const config = createResponsesConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('text/plain', TXT_BASE64)])
        }, config);

        const userMessage = (request.body.input as any[]).find((m: any) => m.type === 'message' && m.role === 'user');
        expect(userMessage).toBeDefined();
        expect(userMessage.content).toContainEqual({
            type: 'input_text',
            text: '[附件内容]\n\nHello txt attachment'
        });
        expect(userMessage.content.some((c: any) => c.type === 'input_image')).toBe(false);
    });

    it('图片附件仍然转换为 input_image 块（不回归）', () => {
        const config = createResponsesConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('image/png', PNG_BASE64)])
        }, config);

        const userMessage = (request.body.input as any[]).find((m: any) => m.type === 'message' && m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'input_image',
            image_url: `data:image/png;base64,${PNG_BASE64}`
        });
    });

    it('PDF 附件转换为 input_file 块（Responses API 支持 base64 内联 PDF）', () => {
        const config = createResponsesConfig();
        const request = formatter.buildRequest({
            configId: config.id,
            history: historyWith([inlineDataPart('application/pdf', 'JVBERi0xLjQ=')])
        }, config);

        const userMessage = (request.body.input as any[]).find((m: any) => m.type === 'message' && m.role === 'user');
        expect(userMessage.content).toContainEqual({
            type: 'input_file',
            filename: 'attachment.pdf',
            file_data: 'data:application/pdf;base64,JVBERi0xLjQ='
        });
        expect(userMessage.content.some((c: any) => c.type === 'input_image')).toBe(false);
        expect(userMessage.content.some((c: any) => c.type === 'input_text')).toBe(false);
    });
});
