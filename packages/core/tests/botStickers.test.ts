import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { botImageId, botInboundParts, isPublicAddress } from '../../../apps/server/src/bots/media';
import { BOT_STICKER_DIRECTORY, botStickerReplies, botStickerTool, withoutBotStickerMarkers } from '../../../apps/server/src/bots/stickers';
import { createOneBotProtocol } from '../../../apps/server/src/bots/onebotProtocol';
import { captureBotEnvironment } from '../../../apps/server/src/bots/prompt';
import { DEFAULT_BOT_ENVIRONMENT, DEFAULT_QQ_BOT_ENVIRONMENT } from '../../../shared/botConversation';
import { fixture } from './fixtures';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=', 'base64');

describe('Bot 表情包', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let root: string;
  const context = (actorId = 'owner') => ({ runId: 'run', actorId, conversationId: 'conversation', signal: new AbortController().signal }) as any;
  beforeEach(async () => {
    f = await fixture(); root = path.join(f.root, BOT_STICKER_DIRECTORY);
    app = {
      storage: {
        getConversation: async () => ({ workspaceId: 'workspace' }),
        readHistory: async () => ({ startIndex: 0, messages: [{ role: 'user', parts: [{ text: `[附件 "a.png"，图片编号 ${botImageId(png)}]` },
          { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] }] }),
      },
      settings: { find: (_kind: string, id: string) => id === 'workspace' ? { id, name: '频道', directory: f.root } : undefined },
      conversation: async () => ({}),
      workspace: (actorId: string) => { if (actorId !== 'owner') throw new Error('This operation is outside the account grant.'); },
    } as unknown as PlatformApplication;
  });
  afterEach(async () => { jest.restoreAllMocks(); await f.cleanup(); });

  test('按图片编号收藏到会话工作区，列出、改名、删除都限定在表情包目录内', async () => {
    const tool = botStickerTool(app);
    expect(tool.effects({ action: 'list' })).toEqual([]);
    expect(tool.effects({ action: 'save', url: 'https://example.com/a.png' })).toEqual(['workspace_write', 'public_read']);
    expect(tool.effects({ action: 'delete' })).toContain('data_delete');
    await expect(tool.execute({ action: 'save', name: '猫猫/震惊', image: botImageId(png) }, context())).resolves.toMatchObject({ name: '猫猫/震惊' });
    await access(path.join(root, '猫猫', '震惊.png'));
    await expect(tool.execute({ action: 'save', name: '猫猫/震惊', image: botImageId(png) }, context())).rejects.toThrow('同名');
    await expect(tool.execute({ action: 'save', name: '../逃逸', image: botImageId(png) }, context())).rejects.toThrow('相对名称');
    await expect(tool.execute({ action: 'save', name: '其他', image: '000000000000' }, context())).rejects.toThrow('图片编号');
    await expect(tool.execute({ action: 'save', name: '访客', image: botImageId(png) }, context('guest'))).rejects.toThrow('grant');
    await expect(tool.execute({ action: 'rename', name: '猫猫/震惊', to: '开心/得意' }, context())).resolves.toMatchObject({ name: '开心/得意' });
    await expect(tool.execute({ action: 'list', query: '开心' }, context('guest'))).resolves.toMatchObject({ total: 1, stickers: ['开心/得意'] });
    await expect(tool.execute({ action: 'delete', name: '开心/得意' }, context())).resolves.toMatchObject({ deleted: '开心/得意' });
    await expect(tool.execute({ action: 'list' }, context())).resolves.toMatchObject({ total: 0 });
  });

  test('网页图片只下载公网 HTTPS，重定向到内网会被拒绝', async () => {
    const tool = botStickerTool(app);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('/redirect')
      ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private.png' } }) : new Response(png));
    await expect(tool.execute({ action: 'save', name: '网图', url: 'https://93.184.216.34/a.png' }, context())).resolves.toMatchObject({ name: '网图' });
    await expect(tool.execute({ action: 'save', name: '内网', url: 'https://93.184.216.34/redirect' }, context())).rejects.toThrow('内网');
    await expect(tool.execute({ action: 'save', name: '明文', url: 'http://93.184.216.34/a.png' }, context())).rejects.toThrow('HTTPS');
    await expect(tool.execute({ action: 'save', name: '回环', url: 'https://[::ffff:127.0.0.1]/a.png' }, context())).rejects.toThrow('内网');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(['93.184.216.34', '2606:4700::1111'].map(isPublicAddress)).toEqual([true, true]);
    expect(['127.0.0.1', '100.64.1.1', '::1', '::ffff:7f00:1', 'fd00::1', 'fe80::1'].some(isPublicAddress)).toBe(false);
  });

  test('回复中的标记换成表情包图片：最多三个、未知名称忽略，流式预览只去掉完整标记', async () => {
    await mkdir(path.join(root, '猫猫'), { recursive: true });
    for (const name of ['猫猫/震惊', '一', '二', '三']) await writeFile(path.join(root, `${name}.png`), png);
    const reply = await botStickerReplies(app, { conversationId: 'conversation' }, '好的 [表情包:猫猫/震惊]\n[表情包：不存在]\n\n\n还有');
    expect(reply.text).toBe('好的\n\n还有');
    expect(reply.replies).toEqual([{ content: '', files: [{ name: '震惊.png', data: png, contentType: 'image/png', sticker: true }] }]);
    const many = await botStickerReplies(app, { conversationId: 'conversation' }, '[表情包:一][表情包:二][表情包:三][表情包:猫猫/震惊]');
    expect(many.text).toBe(''); expect(many.replies).toHaveLength(3);
    expect(withoutBotStickerMarkers('看 [表情包:一] 然后 [表情包:未完')).toBe('看 然后 [表情包:未完');

    // QQ 单独发出的表情包按表情包样式显示，不引用原消息。
    const v11 = createOneBotProtocol({ enabled: true, endpoint: 'ws://127.0.0.1:1', allowedChannelIds: ['group:30'], agentId: 'default', mentionOnly: true });
    const action = await v11.prepareReply(v11.send('group:30', '', '-101'), reply.replies[0], { id: '900', name: 'Bot' }, async () => ({}));
    expect(action.params.message).toEqual([{ type: 'image', data: { file: `base64://${png.toString('base64')}`, name: '震惊.png', sub_type: 1, summary: '[动画表情]' } }]);
  });

  test('收到的图片带图片编号，QQ 会话默认使用 QQ 说话习惯的环境条目', async () => {
    const parts = await botInboundParts({ id: 'm', authorId: '10', channelId: 'group:30', content: '', mentioned: true, direct: false,
      attachments: [{ name: 'a.png', url: 'https://qpic.cn/a', contentType: 'image/*' }] }, 'onebot', async () => png);
    expect(JSON.stringify(parts)).toContain(`图片编号 ${botImageId(png)}`);
    const base = { id: 'm', authorId: '10', channelId: 'group:30', direct: false, botId: '900' };
    expect(captureBotEnvironment({ ...base, platform: 'onebot' }, {}).content).toContain('QQ 不显示 Markdown');
    expect(captureBotEnvironment({ ...base, platform: 'discord' }, {}).content).toBe(DEFAULT_BOT_ENVIRONMENT.content.replace('{{$BOT_CONTEXT}}',
      JSON.stringify({ platform: 'discord', botId: '900', channelId: 'group:30', direct: false })));
    expect(DEFAULT_QQ_BOT_ENVIRONMENT.identityTemplate).toBe(DEFAULT_BOT_ENVIRONMENT.identityTemplate);
  });
});
