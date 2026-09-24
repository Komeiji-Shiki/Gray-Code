import { pinnedFileLocation } from '../workspace/pinnedPaths';
import { workspaceRoots } from '../workspace/paths';
import { TokenCountService } from '../../../../backend/modules/channel/TokenCountService';
import type { ProductSettingsDraft } from '../settings/product';
import { normalizePendingApprovalGate } from '../../../../backend/modules/conversation/pendingApprovalGate';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ActorIdentity, AgentDefinition, PlatformMessage, PlatformConversation, StartRunInput, ContinueRunInput, WorkspaceDefinition } from '@graycode/contracts';
import { PromptAssembler, type PromptAssemblyHost } from '../../../../backend/modules/prompt/PromptAssembler';
import { generateContextBadgeFormatSection, generateMemorySection, wrapPromptSection } from '../../../../backend/modules/prompt/commonSections';
import { getSingleWorkspaceFileTree } from '../../../../backend/modules/prompt/workspaceFileTree';
import { normalizePinnedFiles, readPinnedFileCapped, PINNED_FILE_MAX_TOTAL_BYTES } from '../../../../backend/modules/prompt/pinnedFiles';
import { deserializePromptContextCache, serializePromptContextCache } from '../../../../backend/modules/prompt/promptContextCache';
import type { PlatformApplication } from '../application';
import { formatOpenTabsSection, formatActiveEditorSection } from '../../../../backend/modules/prompt/editorSections';
import { captureEditorSnapshot, previousEditorSnapshot, type PromptEditorSnapshot } from './editorContext';
import { botIdentityMessage, type CapturedBotEnvironment } from '../bots/prompt';
import { botFailureContext } from '../bots/errorSummary';
import { CONTEXT_NOTES_GUIDANCE, CONTEXT_TOOL_NAMES } from '../../../../shared/contextManagement';
import { LONG_MEMORY_GUIDANCE, LONG_MEMORY_TOOL_NAMES } from '../memory/longTerm/content';

/** Capture each turn once. Tool iterations reuse the captured prompt; history retains prior snapshots. */
export class PlatformPromptService {
  constructor(private readonly app: PlatformApplication) {}
  async prepare(input: { request: StartRunInput | ContinueRunInput; agent: AgentDefinition; actor: ActorIdentity; workspace?: WorkspaceDefinition;
    history: PlatformMessage[]; conversation: PlatformConversation; previousTurn?: PlatformMessage; clientId?: string;
    settingsOverride?: ReturnType<PlatformApplication['product']['runtimeSettings']>; preview?: boolean }) {
    if (!('message' in input.request) && normalizePendingApprovalGate((input.conversation.custom as Record<string, unknown> | undefined)?.pendingApprovalGate)) throw new Error('请先确认当前设计、评审或计划文档。');
    const previousRun = (await this.app.storage.listRuns({ conversationId: input.conversation.id, limit: 1 }))[0];
    const failure = previousRun && botFailureContext(previousRun.status, previousRun.error);
    // 失败提示属于本轮动态上下文，不写成用户历史消息，也不进入上一轮的缓存快照。
    const failureMessage: PlatformMessage[] = failure ? [{ role: 'user', contextControl: 'run_failure', parts: [{ text: failure }] }] : [];
    const contextChannel = await this.app.product.channel(input.request.providerId ?? input.agent.providerId);
    const contextManagementMethod = this.app.context.configuration(input.conversation, contextChannel ?? undefined).method;
    const useContextNotes = contextManagementMethod === 'notes';
    // 手动换到笔记窗口后仍提供恢复工具，自动方式继续服从当前渠道，不强迫两者相同。
    const contextRecovery = this.app.context.configuration(input.conversation).method === 'notes'
      || input.history.findLast(message => message.isSummary && !message.isSummarized)?.contextMethod === 'notes';
    const contextToolNames = useContextNotes ? [...CONTEXT_TOOL_NAMES] : contextRecovery ? ['context_history', 'context_notes'] : [];
    if (typeof (input.conversation.custom as Record<string, unknown> | undefined)?.platformSubagentId === 'string') return {
      systemPrompt: input.agent.systemPrompt, toolNames: [...new Set([...input.agent.toolNames, ...contextToolNames])],
      turnContext: { contextManagementMethod },
      ...(useContextNotes || failure ? { promptContext: { historyPlacement: 'entry' as const,
        beforeHistoryMessages: (useContextNotes ? [{ role: 'user', parts: [{ text: CONTEXT_NOTES_GUIDANCE }] }] : []) as PlatformMessage[],
        afterHistoryMessages: failureMessage } } : {}),
    };
    const settings = input.settingsOverride ?? this.app.product.runtimeSettings();
    const conversationMode = (input.conversation.custom as Record<string, unknown> | undefined)?.platformMode;
    const profile = typeof conversationMode === 'string' ? this.app.settings.snapshot().settings.modeProfiles?.[conversationMode as 'chat' | 'code' | 'character'] : undefined;
    const mode = settings.resolvePromptMode(input.request.promptModeId ?? profile?.promptModeId ?? input.agent.promptModeId);
    const conversation = input.conversation;
    const runtime = (conversation?.custom ?? {}) as Record<string, unknown>;
    const botEnvironment = runtime.botEnvironment as CapturedBotEnvironment | undefined;
    const channelWorkspace = botEnvironment?.version === 1 ? this.app.settings.snapshot().settings.workspaces.find(item => item.id === (botEnvironment.channel.workspace as { id?: string } | undefined)?.id) : undefined;
    const workspace = input.actor.role === 'owner' || input.actor.effects.includes('workspace_read') ? input.workspace : undefined;
    // 共享频道环境描述保持一致；文件读取和动态资料仍使用本轮真实工作区权限。
    const environmentWorkspace = channelWorkspace ?? workspace;
    let editor: PromptEditorSnapshot | undefined;
    if (workspace && input.actor.role === 'owner') {
      if (input.previousTurn) editor = previousEditorSnapshot(input.previousTurn, workspace.id);
      else if (input.clientId) editor = captureEditorSnapshot(this.app, input.actor.id, input.clientId, workspace, settings.getDiagnosticsConfig());
    }
    const pinnedFiles: string[] = [];
    let bytes = 0;
    if (workspace) {
      const pins = runtime.inputPinnedFiles !== undefined ? normalizePinnedFiles(runtime.inputPinnedFiles) : settings.getEnabledPinnedFiles();
      for (const pin of pins) {
        if (!pin.enabled || bytes >= PINNED_FILE_MAX_TOTAL_BYTES) continue;
        try {
          const location = pinnedFileLocation(workspace, pin);
          if (!location) continue;
          const absolute = await this.app.files.resolve(workspace, location.absolute);
          const info = await stat(absolute);
          if (!info.isFile()) continue;
          const file = readPinnedFileCapped(absolute, info.size);
          const text = `File: ${location.path}\n${file.content}${file.truncated ? '\n[File truncated]' : ''}`;
          const size = Buffer.byteLength(text);
          if (bytes + size > PINNED_FILE_MAX_TOTAL_BYTES) continue;
          pinnedFiles.push(text); bytes += size;
        } catch (error) {
          pinnedFiles.push(`File: ${pin.path}\n[Unavailable: ${(error as Error).message}]`);
        }
      }
    }
    const source = 'message' in input.request ? input.request.message : undefined;
    const characterTurn = await this.app.characterPipeline.capture(conversation, input.history, source, input.previousTurn);
    const companionTurn = await this.app.companion.capture(input.actor.id, conversation, input.previousTurn);
    const characterSource = source && characterTurn ? await this.app.characterPipeline.transformParts(source.parts, characterTurn, 1, 'source') : undefined;
    const characterDisplay = characterSource && characterTurn ? await this.app.characterPipeline.transformParts(characterSource.parts, characterTurn, 1, 'display') : undefined;
    const language = settings.getUISettings().language;
    const locale = language && language !== 'auto' ? language : Intl.DateTimeFormat().resolvedOptions().locale;
    const sections: PromptAssemblyHost['sections'] = {
      wrapSection: wrapPromptSection,
      cleanupEmptyLines: text => text.replace(/\n{3,}/g, '\n\n').trim(),
      getUserLanguage: () => locale,
      generateStaticEnvironmentSection: () => [environmentWorkspace ? workspaceRoots(environmentWorkspace).map(root => `Workspace ${root.name}: ${root.directory}`).join('\n') + (workspaceRoots(environmentWorkspace).length > 1 ? '\nUse @workspace_name/path for file tools. Commands start in the first workspace directory unless a directory is specified.' : '') : 'No workspace open',
        `Operating System: ${os.platform()} ${os.release()}`, `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `User Language: ${locale}`, "Please respond using the user's language by default."].join('\n'),
      generateContextBadgeFormatSection,
      generateMemorySection: () => settings.isMemoryEnabled() && input.agent.toolNames.some(name=>(LONG_MEMORY_TOOL_NAMES as readonly string[]).includes(name))
        ? wrapPromptSection('长期记忆',LONG_MEMORY_GUIDANCE) : generateMemorySection(settings),
      generateFileTreeSection: (depth, ignores) => workspace ? workspaceRoots(workspace).map(root => (workspaceRoots(workspace).length > 1 ? '@' + root.name + '/\n' : '') + getSingleWorkspaceFileTree(root.directory, depth === -1 ? 100 : depth, ignores)).join('\n\n') : '',
      generateOpenTabsSection: (limit, ignores) => formatOpenTabsSection(editor?.openFiles ?? [], limit, ignores),
      generateActiveEditorSection: ignores => formatActiveEditorSection(editor?.activeFile, ignores),
      generateDiagnosticsSection: () => settings.getDiagnosticsConfig().enabled ? editor?.diagnostics ?? '' : '',
      generatePinnedFilesSection: () => pinnedFiles.join('\n\n'),
      getContext: () => ({ workspaceRoot: workspace?.directory, os: os.platform(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, currentTime: new Date().toISOString() }),
    };
    const assembler = new PromptAssembler({ settings: () => settings, workspacePaths: () => workspace ? workspaceRoots(workspace).map(root => root.directory) : [], sections });
    const previous = [...input.history].reverse().find(message => message.isUserInput && typeof message.turnDynamicContext === 'string');
    const cache = previous ? deserializePromptContextCache(previous.turnDynamicContext as string) : undefined;
    const skills = input.agent.toolNames.includes('read_skill') && (input.actor.role === 'owner' || input.actor.effects.includes('workspace_read'))
      ? (await this.app.skills.items(input.actor.id, conversation.id, workspace?.id, undefined, { workspace, actor: input.actor })).filter(skill => skill.enabled)
          .map(({ id, name, description }) => ({ id, name, description })) : [];
    const context = { characterModules: characterTurn?.modules, characterMacros: characterTurn?.macros, characterInjections: characterTurn?.injections as import('../../../../backend/modules/conversation/types').Content[] | undefined, characterOutlets: characterTurn?.outlets, todoList: runtime.todoList, pinnedFiles: runtime.inputPinnedFiles, skills,
      workspaceUri: workspace ? pathToFileURL(workspace.directory).toString() : undefined };
    const bundle = assembler.getPromptContextBundle(mode, context, { diffBase: cache ? { sectionValues: cache.sectionValues, templateFingerprint: cache.dynamicTemplateFingerprint } : undefined });
    if (useContextNotes) bundle.beforeHistoryMessages.push({ role: 'user', contextControl: 'reminder', parts: [{ text: CONTEXT_NOTES_GUIDANCE }] });
    if (botEnvironment?.version === 1) {
      if (botEnvironment.content.trim()) bundle.beforeHistoryMessages.push({ role: 'user', parts: [{ text: botEnvironment.content }] });
      const identity = botIdentityMessage(botEnvironment, input.actor, input.workspace) as import('../../../../backend/modules/conversation/types').Content | undefined;
      if (identity) {
        bundle.afterHistoryMessages.push(identity);
        bundle.dynamicSnapshotAfterHistoryMessages.push(identity);
      }
      bundle.messages = [...bundle.beforeHistoryMessages, ...bundle.afterHistoryMessages];
      bundle.dynamicSnapshotMessages = [...bundle.dynamicSnapshotBeforeHistoryMessages, ...bundle.dynamicSnapshotAfterHistoryMessages];
      bundle.text = bundle.messages.flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
      bundle.dynamicSnapshotText = bundle.dynamicSnapshotMessages.flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
    }
    const resumed = typeof input.previousTurn?.turnDynamicContext === 'string' ? deserializePromptContextCache(input.previousTurn.turnDynamicContext) : undefined;
    return {
      systemPrompt: assembler.getSystemPrompt(mode, false, context) + this.app.companion.prompt(companionTurn),
      ...(input.preview ? { previewDynamicText: assembler.getDynamicContextText(mode, context) } : {}),
      toolNames: [...new Set([...input.agent.toolNames.filter(name => (!mode.toolPolicy || mode.toolPolicy.includes(name)) && (!profile?.toolNames || profile.toolNames.includes(name))),
        ...contextToolNames, ...(botEnvironment?.version === 1 ? ['bot_read_attachment'] : [])])],
      promptContext: { beforeHistoryMessages: (resumed ?? bundle).beforeHistoryMessages as PlatformMessage[],
        afterHistoryMessages: [...(resumed ?? bundle).afterHistoryMessages as PlatformMessage[], ...failureMessage], historyPlacement: (resumed ?? bundle).historyPlacement,
        taskContextEmbedded: resumed ? input.previousTurn?.botTaskContextEmbedded === true : botEnvironment?.version === 1 },
      messageParts: characterSource?.parts,
      turnContext: { ...(characterTurn ? { characterTurn } : {}), ...(companionTurn ? { companionTurn } : {}), contextManagementMethod },
      messageMetadata: { turnPlatformMode: input.previousTurn?.turnPlatformMode ?? conversationMode ?? 'chat', ...(companionTurn ? { companionTurn } : {}), ...(botEnvironment?.version === 1 ? { botTaskContextEmbedded: true } : {}), ...(editor ? { turnEditorContext: editor } : {}), ...(characterTurn ? { characterTurn, characterOriginalParts: source?.parts, characterDisplayParts: characterDisplay?.parts,
        characterStages: characterSource?.stages, characterDisplayStages: characterDisplay?.stages } : {}), promptModeId: mode.id, turnDynamicContextStrategy: 'preserve', turnDynamicContext: serializePromptContextCache(bundle) },
    };
  }
  async count(actorId: string, draft: ProductSettingsDraft, data: Record<string, any>, workspaceId?: string, clientId?: string) {
    if (typeof data.staticText !== 'string' || !['gemini', 'gemini-interactions', 'openai', 'openai-responses', 'anthropic'].includes(data.channelType)) throw new Error('提示词计数参数无效。');
    const actor = this.app.actor(actorId); if (!actor) throw new Error('账号不存在。');
    const agent = draft.app.agents[0]; if (!agent) throw new Error('请先配置 Agent。');
    const now = Date.now();
    const conversation: PlatformConversation = data.conversationId ? await this.app.conversation(actorId, data.conversationId)
      : { id: 'prompt-preview', title: '', createdAt: now, updatedAt: now, actorId, workspaceId };
    const workspace = typeof conversation.workspaceId === 'string' ? this.app.workspace(actorId, conversation.workspaceId, ['workspace_read']) : undefined;
    const prepared = await this.prepare({ actor, agent, workspace, conversation, history: [], settingsOverride: draft.settings, preview: true, clientId,
      request: { actorId, agentId: agent.id, conversationId: conversation.id, requestKey: 'prompt-preview', promptModeId: draft.settings.getCurrentPromptModeId(),
        message: { id: 'prompt-preview', role: 'user', parts: [{ text: '' }] } } });
    const proxy = draft.settings.getProxySettings();
    const counter = new TokenCountService();
    const count = (text: string) => counter.countTokens(data.channelType, draft.settings.getTokenCountConfig(), [{ role: 'user', parts: [{ text }] }], proxy.enabled ? proxy.url : undefined);
    const dynamicText = 'previewDynamicText' in prepared ? prepared.previewDynamicText ?? '' : '';
    const [staticResult, dynamicResult] = await Promise.all([count(data.staticText), dynamicText ? count(dynamicText) : Promise.resolve({ success: true, totalTokens: 0 })]);
    if (!staticResult.success || !dynamicResult.success) return { success: false, error: staticResult.error ?? ('error' in dynamicResult ? dynamicResult.error : undefined) ?? 'Token 计数失败。' };
    return { success: true, staticTokens: staticResult.totalTokens, dynamicTokens: dynamicResult.totalTokens };
  }

}
