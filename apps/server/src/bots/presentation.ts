import type { PlatformApplication } from '../application';
import type { BotInbound, BotReference } from './gateway';

export const botRenderedMessageKey = (botId: string, channelId: string, messageId: string) => JSON.stringify([botId, channelId, messageId]);

/** 只识别本应用的整行展示标记；代码块中的相同文字属于正文。 */
export function stripDiscordPresentation(text: string): string {
  let fence: string | undefined;
  let removed = false;
  const lines = text.split('\n').filter(line => {
    const boundary = line.match(/^\s*(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = undefined;
      return true;
    }
    if (fence) return true;
    const display = /^\*\*(?:思考完成|已进行思考 \d+(?:\.\d+)? 秒)\*\*\s*$/.test(line)
      || /^-# /.test(line) && /\bTTFT\b/.test(line) && /\bTPS\b/.test(line);
    if (display) removed = true;
    return !display;
  });
  return removed ? lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() : text;
}

/** 引用或转发本 Bot 的显示消息时恢复正文，不删除其他发言人的相似文字。 */
export async function cleanBotPresentationReferences(app: PlatformApplication, message: BotInbound, botId: string): Promise<BotInbound> {
  const clean = async (references: BotReference[]): Promise<BotReference[]> => Promise.all(references.map(async reference => {
    let content = reference.content;
    if (content) {
      const plain = stripDiscordPresentation(content);
      if (plain !== content && (reference.authorId === botId || await app.storage.getRecord('bot-rendered-messages',
        botRenderedMessageKey(botId, reference.channelId ?? message.channelId, reference.id)))) content = plain;
    }
    return { ...reference, content, ...(reference.references ? { references: await clean(reference.references) } : {}) };
  }));
  return { ...message, references: await clean(message.references ?? []) };
}
