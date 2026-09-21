import { randomUUID } from 'node:crypto';
import type { QuestionRequest } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotButton, BotInteraction, BotPanel, BotPanelRow } from './gateway';
import { BotSessions, botRunLabels, type BotAction, type BotContext } from './sessions';

type Screen = 'home' | 'conversations' | 'models' | 'workspaces' | 'approvals' | 'questions';
type Control =
  | { kind: 'screen'; screen: Screen; page?: number }
  | { kind: 'perform'; action: BotAction }
  | { kind: 'select'; choices: Map<string, Control> }
  | { kind: 'approval'; id: string; page?: number }
  | { kind: 'modal'; purpose: 'message' | 'interrupt' | 'conversation'; question?: never }
  | { kind: 'modal'; purpose: 'answer'; question: QuestionRequest }
  | { kind: 'submit'; purpose: 'message' | 'interrupt' | 'conversation'; question?: never }
  | { kind: 'submit'; purpose: 'answer'; question: QuestionRequest };
interface Ticket { context: BotContext; expiresAt: number; control: Control }
interface Choice { label: string; description?: string; control: Control; selected?: boolean }

/** 操作票据绑定真实账号、频道和 Bot；客户端提交的文本只作为回答或消息内容。 */
export class DiscordControls {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly app: PlatformApplication, private readonly sessions: BotSessions,
    private readonly context: (input: BotInteraction) => BotContext) {}
  clear() { this.tickets.clear(); }
  private ticket(context: BotContext, control: Control): string {
    const now = Date.now();
    for (const [id, value] of this.tickets) if (value.expiresAt <= now) this.tickets.delete(id);
    while (this.tickets.size >= 1000) this.tickets.delete(this.tickets.keys().next().value!);
    const id = `gray:${randomUUID()}`;
    this.tickets.set(id, { context, control, expiresAt: now + 15 * 60000 });
    return id;
  }
  private button(context: BotContext, label: string, control: Control, options: Pick<BotButton, 'disabled' | 'style'> = {}): BotButton {
    return { id: this.ticket(context, control), label, ...options };
  }
  async handle(input: BotInteraction): Promise<void> {
    try {
      const context = this.context(input);
      this.sessions.authorize(context);
      let control: Control = { kind: 'screen', screen: 'home' };
      if (input.kind !== 'command') {
        const ticket = input.customId && this.tickets.get(input.customId);
        if (!ticket || ticket.expiresAt <= Date.now() || ticket.context.authorId !== context.authorId
          || ticket.context.channelId !== context.channelId || ticket.context.botId !== context.botId) throw new Error('这个菜单已经过期，或不属于当前账号。请重新输入 /gray。');
        control = ticket.control;
        if (control.kind !== 'screen') this.tickets.delete(input.customId!);
        if (control.kind === 'select') {
          if (input.kind !== 'select' || input.values?.length !== 1 || !control.choices.has(input.values[0])) throw new Error('选择已失效，请重新打开菜单。');
          control = control.choices.get(input.values[0])!;
        }
      }
      if (control.kind === 'modal') {
        if (input.kind === 'modal') throw new Error('表单已经处理，请重新打开面板。');
        const fields = control.purpose === 'answer' ? control.question.questions.map((question, index) => ({ id: `answer_${index}`, label: question.title,
          placeholder: question.options?.join(' / ') })) : [{ id: 'text', label: control.purpose === 'conversation' ? '对话 ID' : control.purpose === 'interrupt' ? '追加给当前任务的说明' : '发送给 GrayCode 的消息' }];
        if (fields.length > 5) throw new Error('这个问题包含超过五项内容，请在桌面端回答。');
        await input.showModal({ id: this.ticket(context, { ...control, kind: 'submit' }), title: control.purpose === 'answer' ? '回答任务问题' : control.purpose === 'conversation' ? '打开已有对话' : '发送消息', fields });
        return;
      }
      await input.defer();
      if (control.kind === 'screen') { await input.respond(await this.render(context, control.screen, control.page ?? 0)); return; }
      if (control.kind === 'approval') { await input.respond(await this.approval(context, control.id, control.page)); return; }
      let action: BotAction;
      if (control.kind === 'perform') action = control.action;
      else if (control.kind === 'submit' && input.kind === 'modal') {
        const text = input.fields?.text?.trim() ?? '';
        action = control.purpose === 'answer' ? { kind: 'answer', questionId: control.question.id,
          answers: control.question.questions.map((_, index) => input.fields?.[`answer_${index}`]?.trim() ?? '') }
          : control.purpose === 'conversation' ? { kind: 'conversation', conversationId: text } : { kind: control.purpose, text };
      } else throw new Error('操作类型无效，请重新打开面板。');
      const result = await this.sessions.perform(context, action);
      await input.respond(await this.home(context, result.run ? '任务已经开始，可查看状态或停止任务。' : result.reply));
    } catch (error) {
      await input.respond({ content: error instanceof Error ? error.message : '操作未完成，请重新打开 /gray。' });
    }
  }
  private async home(context: BotContext, notice = ''): Promise<BotPanel> {
    const state = await this.sessions.snapshot(context);
    const owner = state.loaded.actor.role === 'owner';
    const canControl = owner || state.run?.actorId === state.loaded.actor.id;
    const first: BotButton[] = [
      ...(owner ? [this.button(context, '新建对话', { kind: 'perform', action: { kind: 'new' } })] : []),
      this.button(context, state.active ? '追加说明' : '发消息', { kind: 'modal', purpose: state.active ? 'interrupt' : 'message' }, { style: 'primary', disabled: state.active && !canControl }),
      ...(owner ? [this.button(context, '切换对话', { kind: 'screen', screen: 'conversations' })] : []),
    ];
    if (state.loaded.actor.role === 'owner') first.push(this.button(context, '切换模型', { kind: 'screen', screen: 'models' }));
    if (owner) first.push(this.button(context, '切换工作区', { kind: 'screen', screen: 'workspaces' }));
    const second: BotButton[] = [this.button(context, '刷新状态', { kind: 'screen', screen: 'home' }),
      this.button(context, '停止任务', { kind: 'perform', action: { kind: 'cancel' } }, { style: 'danger', disabled: !state.active || !canControl })];
    if (state.approvals.length) second.push(this.button(context, `待确认 ${state.approvals.length}`, { kind: 'screen', screen: 'approvals' }, { style: 'primary' }));
    if (state.questions.length) second.push(this.button(context, `待回答 ${state.questions.length}`, { kind: 'screen', screen: 'questions' }, { style: 'primary' }));
    return { content: `**GrayCode 操作面板**\n对话：${state.conversation?.title || '尚未选择'}\n后续模型：${state.provider?.name || '未配置'} / ${state.model || '未选择'}\n工作区：${state.workspace?.name || '普通聊天'}\n状态：${state.run ? `${botRunLabels[state.run.status]} · 第 ${state.run.iteration} 轮` : '没有正在执行的任务'}${notice ? `\n\n${notice}` : ''}\n\n这个面板仅对你可见。`,
      rows: [{ buttons: first }, { buttons: second }] };
  }
  private choices(context: BotContext, screen: Screen, title: string, choices: Choice[], page: number, extras: BotButton[] = [], navigate?: (page: number) => Control): BotPanel {
    const pages = Math.max(1, Math.ceil(choices.length / 25));
    page = Math.max(0, Math.min(pages - 1, page));
    const visible = choices.slice(page * 25, (page + 1) * 25);
    const rows: BotPanelRow[] = [];
    if (visible.length) rows.push({ select: { id: this.ticket(context, { kind: 'select', choices: new Map(visible.map((choice, index) => [String(index), choice.control])) }),
      placeholder: '请选择', options: visible.map((choice, index) => ({ label: choice.label, description: choice.description, value: String(index), selected: choice.selected })) } });
    const buttons = [this.button(context, '返回', { kind: 'screen', screen: 'home' })];
    if (page > 0) buttons.push(this.button(context, '上一页', navigate?.(page - 1) ?? { kind: 'screen', screen, page: page - 1 }));
    if (page + 1 < pages) buttons.push(this.button(context, '下一页', navigate?.(page + 1) ?? { kind: 'screen', screen, page: page + 1 }));
    rows.push({ buttons: [...buttons, ...extras] });
    return { content: `**${title}**\n${choices.length ? `第 ${page + 1} / ${pages} 页，共 ${choices.length} 项。` : '目前没有可选项。'}`, rows };
  }
  private async render(context: BotContext, screen: Screen, page: number): Promise<BotPanel> {
    if (screen === 'home') return this.home(context);
    const state = await this.sessions.snapshot(context);
    if (screen === 'conversations') {
      const choices = (await this.sessions.conversations(state.loaded.actor.id, context)).map(conversation => ({ label: conversation.title || '未命名对话',
        description: new Date(conversation.updatedAt).toLocaleString('zh-CN'), selected: state.conversation?.id === conversation.id,
        control: { kind: 'perform', action: { kind: 'conversation', conversationId: conversation.id } } as Control }));
      return this.choices(context, screen, '切换对话 · 最近 200 项', choices, page,
        [this.button(context, '按对话 ID 打开', { kind: 'modal', purpose: 'conversation' })]);
    }
    if (screen === 'models') return this.choices(context, screen, '选择后续请求的模型', this.sessions.models(state.loaded.actor.id).map(model => ({
      label: model.label, description: model.providerName, selected: state.provider?.id === model.providerId && state.model === model.modelId,
      control: { kind: 'perform', action: { kind: 'model', providerId: model.providerId, modelId: model.modelId } },
    })), page, [this.button(context, '使用默认模型', { kind: 'perform', action: { kind: 'model-default' } })]);
    if (screen === 'workspaces') return this.choices(context, screen, '选择后续任务的工作区', [
      { label: '普通聊天，不绑定工作区', control: { kind: 'perform', action: { kind: 'workspace', workspaceId: null } } },
      ...this.sessions.workspaces(state.loaded.actor.id).map(workspace => ({ label: workspace.name, description: workspace.id,
        control: { kind: 'perform', action: { kind: 'workspace', workspaceId: workspace.id } } as Control })),
    ], page);
    if (screen === 'approvals') return this.choices(context, screen, '等待确认的操作', state.approvals.map(approval => ({ label: approval.toolName,
      description: '打开后查看完整参数，再决定允许或拒绝', control: { kind: 'approval', id: approval.id } })), page);
    return this.choices(context, screen, '等待回答的问题', state.questions.map(question => ({ label: question.questions[0]?.title || '任务问题',
      description: `${question.questions.length} 个问题`, control: { kind: 'modal', purpose: 'answer', question } })), page);
  }
  private async approval(context: BotContext, id: string, page = 0): Promise<BotPanel> {
    const state = await this.sessions.snapshot(context);
    const request = state.approvals.find(item => item.id === id);
    if (!request) throw new Error('这个确认请求已经结束。');
    if (request.choices?.length) {
      const panel = this.choices(context, 'approvals', `选择权限：${request.toolName}`, request.choices.map((choice, index) => ({
        label: `${index + 1}. ${choice.label}`, control: { kind: 'perform', action: {
          kind: 'approval', approvalId: id, accepted: choice.kind.startsWith('allow'), choiceId: choice.id,
        } },
      })), page, [], next => ({ kind: 'approval', id, page: next }));
      panel.content += '\n请先查看附件中的完整操作和选项说明，再选择。';
      panel.files = [{ name: '操作与选项.json', data: Buffer.from(JSON.stringify({ args: request.args, reason: request.reason, choices: request.choices }, null, 2)) }];
      return panel;
    }
    const params = JSON.stringify(request.args, null, 2);
    return { content: `**确认操作：${request.toolName}**\n${params.length <= 1300 ? `\`\`\`json\n${params}\n\`\`\`` : '完整参数保存在附件中，请查看后再确认。'}`,
      ...(params.length > 1300 ? { files: [{ name: '操作参数.json', data: Buffer.from(params) }] } : {}), rows: [{ buttons: [
        this.button(context, '允许这次操作', { kind: 'perform', action: { kind: 'approval', approvalId: id, accepted: true } }, { style: 'primary' }),
        this.button(context, '拒绝', { kind: 'perform', action: { kind: 'approval', approvalId: id, accepted: false } }, { style: 'danger' }),
        this.button(context, '返回', { kind: 'screen', screen: 'home' }),
      ] }] };
  }
}
