import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { botImageId, botInboundParts, isPublicAddress } from '../../../apps/server/src/bots/media';
import { saveBotImage } from '../../../apps/server/src/bots/documents';
import { BOT_IMAGE_DIRECTORY } from '../../../shared/botConversation';
import { BOT_STICKER_DIRECTORY, botStickerReplies, botStickerTool, withoutBotStickerMarkers } from '../../../apps/server/src/bots/stickers';
import { createOneBotProtocol } from '../../../apps/server/src/bots/onebotProtocol';
import { captureBotEnvironment } from '../../../apps/server/src/bots/prompt';
import { oneBotContent } from '../../../apps/server/src/bots/onebotContent';
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
    expect(tool.effects({ action: 'save', image: botImageId(png) })).toEqual([]);
    expect(tool.effects({ action: 'save', url: 'https://example.com/a.png' })).toEqual(['workspace_write', 'public_read']);
    expect(tool.effects({ action: 'delete' })).toContain('data_delete');
    // 名称被另一张图占用时报错；同一张图再次收藏时返回已有名称。
    await mkdir(root, { recursive: true }); await writeFile(path.join(root, '占用.png'), Buffer.concat([png, Buffer.from([0])]));
    await expect(tool.execute({ action: 'save', name: '占用', image: botImageId(png) }, context())).rejects.toThrow('同名');
    await expect(tool.execute({ action: 'delete', name: '占用' }, context())).resolves.toMatchObject({ deleted: '占用' });
    await expect(tool.execute({ action: 'save', name: '猫猫/震惊', image: botImageId(png) }, context())).resolves.toMatchObject({ name: '猫猫/震惊' });
    await access(path.join(root, '猫猫', '震惊.png'));
    await expect(tool.execute({ action: 'save', name: '另起一个名字', image: botImageId(png) }, context())).resolves.toMatchObject({ name: '猫猫/震惊', duplicate: true });
    await expect(tool.execute({ action: 'save', name: '../逃逸', image: botImageId(png) }, context())).rejects.toThrow('相对名称');
    await expect(tool.execute({ action: 'save', name: '其他', image: '000000000000' }, context())).rejects.toThrow('图片编号');
    // 访客触发的任务也能收藏聊天中的图片；同一张图返回已有名称，下载和整理仍需要写入权限。
    await expect(tool.execute({ action: 'save', name: '访客收藏', image: botImageId(png) }, context('guest'))).resolves.toEqual({ success: true, name: '猫猫/震惊', duplicate: true });
    await expect(tool.execute({ action: 'save', name: '访客下载', url: 'https://93.184.216.34/a.png' }, context('guest'))).rejects.toThrow('grant');
    await expect(tool.execute({ action: 'rename', name: '猫猫/震惊', to: '访客改名' }, context('guest'))).rejects.toThrow('grant');
    await expect(tool.execute({ action: 'rename', name: '猫猫/震惊', to: '开心/得意' }, context())).resolves.toMatchObject({ name: '开心/得意' });
    await expect(tool.execute({ action: 'list', query: '开心' }, context('guest'))).resolves.toMatchObject({ total: 1, stickers: ['开心/得意'] });
    await expect(tool.execute({ action: 'delete', name: '开心/得意' }, context())).resolves.toMatchObject({ deleted: '开心/得意' });
    await expect(tool.execute({ action: 'list' }, context())).resolves.toMatchObject({ total: 0 });
  });

  test('收到的图片保存到会话工作区，消息标签带相对路径且重复图片复用文件', async () => {
    const saved = await saveBotImage(app, 'conversation', { name: '猫 图.png', url: 'https://cdn.discordapp.com/a' }, png, 'image/png');
    expect(saved).toMatchObject({ id: botImageId(png), mimeType: 'image/png' });
    expect(saved!.relativePath).toBe(`${BOT_IMAGE_DIRECTORY}/${botImageId(png)}-猫 图.png`);
    await access(path.join(f.root, saved!.relativePath));
    const again = await saveBotImage(app, 'conversation', { name: '另一张.png', url: 'https://cdn.discordapp.com/b' }, png, 'image/png');
    expect(again!.path).not.toBe(saved!.path);
    expect(await saveBotImage(app, 'conversation', { name: '猫 图.png', url: 'https://cdn.discordapp.com/c' }, png, 'image/png'))
      .toMatchObject({ path: saved!.path });
    expect(await saveBotImage({ ...app, storage: { getConversation: async () => undefined } } as unknown as PlatformApplication,
      'conversation', { name: '无工作区.png', url: '' }, png, 'image/png')).toBeUndefined();
    const inbound = { id: 'm', authorId: '10', channelId: '30', direct: false, mentioned: false, content: '',
      attachments: [{ name: '猫 图.png', url: 'https://cdn.discordapp.com/a', contentType: 'image/png' }] };
    const parts = await botInboundParts(inbound, 'discord', async () => png, undefined,
      async () => ({ relativePath: saved!.relativePath } as any));
    const label = parts.map(part => part.text).find(text => typeof text === 'string' && text.startsWith('[附件'));
    expect(label).toContain(`工作区路径 "${saved!.relativePath}"`);
    expect(parts.some(part => part.inlineData)).toBe(true);
  });

  test('动图只把第 1 帧交给模型，完整 GIF 留在工作区并可按编号收藏', async () => {
    const solid = (color: number[]) => Buffer.concat(Array.from({ length: 16 * 16 }, () => Buffer.from(color)));
    const gif = await sharp(Buffer.concat([solid([255, 0, 0]), solid([0, 0, 255])]), { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } })
      .gif({ delay: [100, 100], loop: 0 }).toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    const inbound = { id: 'm', authorId: '10', channelId: '30', direct: false, mentioned: false, content: '',
      attachments: [{ name: '转圈.gif', url: 'https://cdn.discordapp.com/a', contentType: 'image/gif' }] };
    const parts = await botInboundParts(inbound, 'discord', async () => gif, undefined,
      (attachment, bytes, mimeType) => saveBotImage(app, 'conversation', attachment, bytes, mimeType));
    const label = parts.map(part => part.text).find(text => typeof text === 'string' && text.startsWith('[附件'));
    expect(label).toContain('动图只提供第 1 帧'); expect(label).toContain(`图片编号 ${botImageId(gif)}`);
    expect(label).toContain(`工作区路径 "${BOT_IMAGE_DIRECTORY}/${botImageId(gif)}-转圈.gif"`);
    const image = parts.find(part => part.inlineData)!.inlineData as { mimeType: string; data: string };
    expect(image.mimeType).toBe('image/png');
    const still = Buffer.from(image.data, 'base64');
    expect((await sharp(still, { animated: true }).metadata())).toMatchObject({ format: 'png', width: 16, height: 16 });
    const pixel = await sharp(still).removeAlpha().raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(200); expect(pixel[2]).toBeLessThan(60);
    await expect(readFile(path.join(f.root, BOT_IMAGE_DIRECTORY, `${botImageId(gif)}-转圈.gif`))).resolves.toEqual(gif);
    // 历史里没有这个编号的原图（只有第 1 帧），收藏取工作区保存的完整 GIF。
    await expect(botStickerTool(app).execute({ action: 'save', name: '转圈', image: botImageId(gif) }, context())).resolves.toMatchObject({ name: '转圈' });
    await expect(readFile(path.join(root, '转圈.gif'))).resolves.toEqual(gif);
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

  test('收到的图片带图片编号并标出 QQ 表情包，QQ 会话默认使用 QQ 说话习惯的环境条目', async () => {
    const content = oneBotContent([{ type: 'image', data: { file: 'a.png', url: 'https://qpic.cn/a', sub_type: 1, summary: '[开心]' } },
      { type: 'image', data: { file: 'b.gif', url: 'https://gxh.vip.qq.com/b', emoji_id: 'x', summary: '[动画表情]' } },
      { type: 'image', data: { file: 'c.png', url: 'https://qpic.cn/c', sub_type: 0 } }], '900', 11);
    expect(content.attachments.map(item => [item.sticker, item.summary])).toEqual([[true, '[开心]'], [true, undefined], [undefined, undefined]]);
    const parts = await botInboundParts({ id: 'm', authorId: '10', channelId: 'group:30', direct: false, ...content }, 'onebot', async () => png);
    const labels = parts.flatMap(part => typeof part.text === 'string' && part.text.startsWith('[附件') ? [part.text] : []);
    expect(labels).toEqual([`[附件 "image.png"，QQ 表情包 [开心]，图片编号 ${botImageId(png)}]`, `[附件 "image.png"，QQ 表情包，图片编号 ${botImageId(png)}]`,
      `[附件 "image.png"，图片编号 ${botImageId(png)}]`]);
    const base = { id: 'm', authorId: '10', channelId: 'group:30', direct: false, botId: '900' };
    expect(captureBotEnvironment({ ...base, platform: 'onebot' }, {}).content).toContain('QQ 不显示 Markdown');
    expect(captureBotEnvironment({ ...base, platform: 'discord' }, {}).content).toBe(DEFAULT_BOT_ENVIRONMENT.content.replace('{{$BOT_CONTEXT}}',
      JSON.stringify({ platform: 'discord', botId: '900', channelId: 'group:30', direct: false })));
    expect(DEFAULT_QQ_BOT_ENVIRONMENT.identityTemplate).toBe(DEFAULT_BOT_ENVIRONMENT.identityTemplate);
  });
});
