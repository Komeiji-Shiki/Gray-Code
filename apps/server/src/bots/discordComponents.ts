import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { BotModal, BotPanel } from './gateway';
import { clipBotText as cut } from './text';

/** 原生交互只接收服务端生成的操作标识，组件文本不会被当作执行指令。 */
export function discordPanel(panel: BotPanel) {
  if ((panel.rows?.length ?? 0) > 5) throw new Error('操作面板最多包含五行控件。');
  return { content: cut(panel.content, 2000), allowedMentions: { parse: [] as const, repliedUser: false },
    files: panel.files?.map(file => ({ name: file.name, attachment: Buffer.from(file.data) })),
    components: (panel.rows ?? []).map(row => {
      if ('buttons' in row) return new ActionRowBuilder<ButtonBuilder>().addComponents(row.buttons.map(button => new ButtonBuilder()
        .setCustomId(button.id).setLabel(cut(button.label, 80)).setDisabled(button.disabled === true)
        .setStyle(button.style === 'danger' ? ButtonStyle.Danger : button.style === 'primary' ? ButtonStyle.Primary : ButtonStyle.Secondary)));
      const select = new StringSelectMenuBuilder().setCustomId(row.select.id).setPlaceholder(cut(row.select.placeholder, 150))
        .setOptions(row.select.options.map(option => ({ label: cut(option.label, 100), value: option.value,
          ...(option.description ? { description: cut(option.description, 100) } : {}), default: option.selected === true })));
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    }) };
}

export function discordModal(modal: BotModal) {
  return new ModalBuilder().setCustomId(modal.id).setTitle(cut(modal.title, 45))
    .addComponents(modal.fields.map(field => {
      const input = new TextInputBuilder().setCustomId(field.id).setLabel(cut(field.label, 45))
        .setStyle(TextInputStyle.Paragraph).setRequired(field.required !== false).setMaxLength(4000);
      if (field.placeholder) input.setPlaceholder(cut(field.placeholder, 100));
      if (field.value) input.setValue(cut(field.value, 4000));
      return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    }));
}
