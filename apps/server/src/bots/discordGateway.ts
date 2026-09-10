import { ApplicationIntegrationType, ChannelType, Client, Events, GatewayIntentBits, InteractionContextType, MessageFlags,
  Partials, PermissionFlagsBits, SlashCommandBuilder, type Channel, type Interaction, type Message, type MessageSnapshot } from 'discord.js';
import { discordModal, discordPanel } from './discordComponents';

import type { BotChannel, BotGateway, BotInbound, BotInteraction, BotReply, BotReference } from './gateway';
export type DiscordInbound = BotInbound;
export type DiscordGateway = BotGateway;

/** Only authenticated Gateway events reach the application identity resolver. */
export class DiscordJsGateway implements DiscordGateway {
  private client?: Client;
  private interactionHandler?: (interaction: BotInteraction) => Promise<void>;
  setInteractionHandler(handler: (interaction: BotInteraction) => Promise<void>) { this.interactionHandler = handler; }
  async connect(token: string, allMessages: boolean, receive: (message: DiscordInbound) => void, state: (status: string) => void) {
    const client = this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages,
        ...(allMessages ? [GatewayIntentBits.MessageContent] : [])],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
    });
    client.on(Events.MessageCreate, message => {
      if (!client.user || message.author.id === client.user.id) return;
      receive({ ...this.messageContent(message), id: message.id, authorId: message.author.id, channelId: message.channelId,
        mentioned: message.mentions.users.has(client.user.id), direct: !message.guildId,
        authorName: message.author.displayName, automated: message.author.bot || !!message.webhookId,
        repliedToBot: message.mentions.repliedUser?.id === client.user.id, guildId: message.guildId ?? undefined });
    });
    client.on(Events.InteractionCreate, interaction => { void this.interaction(interaction); });
    client.on(Events.ShardReconnecting, () => state("reconnecting"));
    client.on(Events.ShardResume, () => state("connected"));
    client.on(Events.Error, () => state("connection_error"));
    client.on(Events.ShardError, () => state("connection_error"));
    try {
      await client.login(token);
      if (!client.isReady()) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Discord connection timed out.")), 30_000);
        client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
      });
      let controlsReady = false;
      try {
        // 只创建或更新本应用的 gray 命令，保留这个 Bot 已有的其他命令。
        await client.application!.commands.create(new SlashCommandBuilder().setName('gray').setDescription('打开 GrayCode 对话与任务操作面板')
          .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM).setIntegrationTypes(ApplicationIntegrationType.GuildInstall));
        controlsReady = true;
      } catch { /* 连接仍可使用，注册问题单独显示在管理页。 */ }
      return { id: client.user!.id, name: client.user!.username, avatarUrl: client.user!.displayAvatarURL(), controlsReady,
        ...(!controlsReady ? { warning: '已连接，但 /gray 命令注册失败。请在管理页重新连接并检查应用命令权限。' } : {}) };
    } catch {
      await this.disconnect();
      // SDK failures can contain request details. Do not expose the supplied credential.
      throw new Error('Discord 连接失败，请检查 Token、网络和需要的 Gateway Intents。');
    }
  }
  private messageContent(message: Message | MessageSnapshot): Pick<BotInbound, 'content' | 'timestamp' | 'attachments' | 'references'> {
    const references: BotReference[] = [];
    if (message.messageSnapshots?.size) {
      for (const [id, snapshot] of message.messageSnapshots) references.push({ kind: 'forward', id,
        channelId: message.reference?.channelId, ...this.messageContent(snapshot) });
    } else if (message.reference?.messageId) references.push({ kind: message.reference.type === 1 ? 'forward' : 'reply',
      id: message.reference.messageId, channelId: message.reference.channelId });
    const attachments = [...message.attachments.values()].map(file => ({ name: file.name, url: file.url, contentType: file.contentType ?? undefined, size: file.size }));
    const text = [message.content];
    // 粘贴的图片链接与转发卡片可能只出现在 embeds 中，沿用平台代理地址读取。
    for (const [index, embed] of (message.embeds ?? []).entries()) {
      const description = [embed.title, embed.description, embed.url,
        ...(embed.fields ?? []).map(field => `${field.name}\n${field.value}`)].filter(Boolean).join('\n');
      if (description) text.push(`[Discord 嵌入内容 ${index + 1}]\n${description}\n[嵌入内容结束]`);
      for (const asset of [embed.image, embed.thumbnail]) {
        const url = asset?.proxyURL ?? asset?.url;
        if (url && !attachments.some(item => item.url === url)) attachments.push({ name: `嵌入图片 ${index + 1}`, url, contentType: 'image/*', size: 0 });
      }
    }
    return { content: text.filter(Boolean).join('\n'), timestamp: message.createdTimestamp, attachments, references };
  }
  async hydrate(message: BotInbound): Promise<BotInbound> {
    const seen = new Set<string>([`${message.channelId}:${message.id}`]);
    const expand = async (refs: BotReference[], depth: number): Promise<BotReference[]> => {
      const result: BotReference[] = [];
      for (const ref of refs) {
        const key = `${ref.channelId}:${ref.id}`;
        if (depth >= 4 || seen.has(key)) { result.push({ ...ref, unavailable: '引用层数已达上限或存在循环引用' }); continue; }
        seen.add(key);
        // 快照正文已经随 Gateway 到达，仍需展开其中的引用；不重新读取或覆盖快照原文。
        if (ref.content !== undefined) {
          result.push({ ...ref, references: await expand(ref.references ?? [], depth + 1) });
          continue;
        }
        try {
          const channel = await this.ready().channels.fetch(ref.channelId ?? message.channelId);
          if (!channel?.isTextBased()) throw new Error('引用频道不可访问');
          const original = await channel.messages.fetch(ref.id);
          const content = this.messageContent(original);
          result.push({ ...ref, ...content, authorId: original.author.id, authorName: original.author.displayName,
            references: await expand(content.references ?? [], depth + 1) });
        } catch { result.push({ ...ref, unavailable: '原消息已删除、Bot 缺少读取权限，或平台请求失败' }); }
      }
      return result;
    };
    return { ...message, references: await expand(message.references ?? [], 0) };
  }
  async send(channelId: string, content: string): Promise<void> {
    await this.sendReply(channelId, { content });
  }
  private ready(): Client<true> {
    if (!this.client?.isReady()) throw new Error('Discord 尚未连接。');
    return this.client;
  }
  async sendReply(channelId: string, reply: BotReply, nonce?: string) {
    const channel = await this.ready().channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('这个 Discord 频道目前无法接收消息。');
    const message = await channel.send({ content: reply.content, files: reply.files?.map(file => ({ name: file.name, attachment: Buffer.from(file.data) })),
      ...(nonce ? { nonce, enforceNonce: true } : {}), allowedMentions: { parse: [], repliedUser: false } });
    return { id: message.id };
  }
  async editReply(channelId: string, messageId: string, reply: BotReply) {
    const channel = await this.ready().channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('这个 Discord 频道目前无法编辑消息。');
    await channel.messages.edit(messageId, { content: reply.content, attachments: [],
      files: reply.files?.map(file => ({ name: file.name, attachment: Buffer.from(file.data) })), allowedMentions: { parse: [], repliedUser: false } });
  }
  async deleteReply(channelId: string, messageId: string) {
    const channel = await this.ready().channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('这个 Discord 频道目前无法更新流式回复。');
    await channel.messages.delete(messageId).catch(error => {
      // 已删除的同一条回执可以安全重试，其他错误保留给发件箱处理。
      if ((error as { code?: number }).code !== 10008) throw error;
    });
  }
  async listGuilds() {
    return [...this.ready().guilds.cache.values()].map(guild => ({ id: guild.id, name: guild.name,
      iconUrl: guild.iconURL() ?? undefined, unavailable: !guild.available })).sort((a, b) => a.name.localeCompare(b.name));
  }
  private describe(channel: Channel): BotChannel {
    const guild = 'guild' in channel ? channel.guild : undefined;
    const permissions = 'permissionsFor' in channel ? channel.permissionsFor(this.ready().user) : undefined;
    const permitted = !guild || !!permissions?.has([PermissionFlagsBits.ViewChannel,
      channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages]);
    return { id: channel.id, guildId: guild?.id, name: 'name' in channel ? channel.name ?? channel.id : channel.id,
      category: 'parent' in channel ? channel.parent?.name : undefined,
      type: ChannelType[channel.type], available: channel.isSendable() && permitted, direct: channel.isDMBased() };
  }
  async listChannels(guildId: string) {
    const guild = this.ready().guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot 尚未加入这个服务器。');
    const channels = await guild.channels.fetch();
    const activeThreads = await guild.channels.fetchActiveThreads();
    return [...channels.values(), ...activeThreads.threads.values()].filter((channel): channel is NonNullable<typeof channel> => !!channel)
      .map(channel => this.describe(channel)).filter(channel => !['GuildCategory', 'GuildVoice', 'GuildStageVoice'].includes(channel.type))
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name));
  }
  async getChannel(channelId: string) {
    const channel = await this.ready().channels.fetch(channelId);
    if (!channel) throw new Error('频道不存在或 Bot 已失去访问权限。');
    return this.describe(channel);
  }
  async getUser(userId: string) {
    if (!/^\d{1,20}$/.test(userId)) throw new Error('请输入 Discord 数字用户 ID，不是用户名或昵称。');
    try {
      const user = await this.ready().users.fetch(userId);
      return { id: user.id, name: user.username, displayName: user.displayName, avatarUrl: user.displayAvatarURL(), bot: user.bot };
    } catch { throw new Error('无法读取这个 Discord 账号，请检查数字用户 ID。'); }
  }
  private async interaction(interaction: Interaction) {
    if (!this.interactionHandler || !interaction.channelId) return;
    if (interaction.isChatInputCommand() ? interaction.commandName !== 'gray'
      : (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) ? !interaction.customId.startsWith('gray:') : true) return;
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    const input: BotInteraction = {
      id: interaction.id, authorId: interaction.user.id, channelId: interaction.channelId, direct: !interaction.guildId, guildId: interaction.guildId ?? undefined,
      kind: interaction.isChatInputCommand() ? 'command' : interaction.isButton() ? 'button' : interaction.isStringSelectMenu() ? 'select' : 'modal',
      ...('customId' in interaction ? { customId: interaction.customId } : {}),
      ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
      ...(interaction.isModalSubmit() ? { fields: Object.fromEntries([...interaction.fields.fields].flatMap(([id, field]) => 'value' in field && typeof field.value === 'string' ? [[id, field.value]] : [])) } : {}),
      defer: async () => {
        if (interaction.deferred || interaction.replied) return;
        if (interaction.isButton() || interaction.isStringSelectMenu()) await interaction.deferUpdate();
        else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      },
      respond: async panel => {
        const payload = discordPanel(panel);
        if (interaction.deferred || interaction.replied) await interaction.editReply({ ...payload, attachments: [] });
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      },
      showModal: async modal => {
        if (interaction.isModalSubmit()) throw new Error('不能从表单提交再次打开表单。');
        await interaction.showModal(discordModal(modal));
      },
    };
    try { await this.interactionHandler(input); }
    catch { await input.respond({ content: '操作未完成，请在桌面端查看对应任务或重新打开 /gray 面板。' }).catch(() => {}); }
  }
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.destroy();
  }
}
