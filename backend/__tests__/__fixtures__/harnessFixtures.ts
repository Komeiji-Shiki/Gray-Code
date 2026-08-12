/**
 * 测试共享 fixture：service 测试 harness 系列（createHarness 收敛批次）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明：原 backend/__tests__ 下 23 个本地 createHarness 定义中 15 个按形状收敛为 7 个共享导出：
 * - createMessageRouterHarness：webview/messageRouterStreamRouting + messageRouterNonBlockingBehavior
 *   （两个文件定义完全同构）。
 * - createToolLoopHarness：api/toolIterationLoopCancel + tools/toolLoopMailboxAbort（同构；
 *   差异仅 conversationManager 是否含 setCustomMetadata 与返回字段，统一为超集：含 setCustomMetadata
 *   并返回 contextTrimService；ToolIterationLoopService 两侧都不消费被补上的差异 mock）。
 * - createAutoSummarizeToolLoopHarness：api/nonStreamAutoSummarizeTurn + api/streamAutoSummaryChunk
 *   （同服务同依赖；差异在 contextTrimService 的 needsAutoSummarize 序列（nonStream 恒 true /
 *   stream 首调 true 后续 false）与 summarizeService 注入方式，以 options.summarizeService /
 *   options.summarizeResult 区分两种模式）。
 * - createContextTrimHarness：api/contextTrimValidSuffixEquivalence + api/contextTrimFallbackStableStart
 *   （差异：historyRef 参数与 getHistoryRef/getHistoryForAPIFrom/estimateMessageTokens 实现，
 *   统一为 historyRef 可选 + tokenCountByChannel 感知版本；validSuffix 侧只调 computeValidSuffixMap，
 *   不消费这些方法，行为不变）。
 * - createChatFlowHarness：api/editRetryMessageId + conversation/branchHistoryDeleteSync
 *   （统一为 editRetry 的 14 个 conversationManager mock 超集 + configManager/diffInterruptService/
 *   checkpointService/toolIterationLoopService/messageBuilderService；branch 侧通过 options.branchService
 *   注入分支图 mock 并在 harness 内 setGlobalBranchService；handleDeleteToMessage 路径不消费
 *   configManager.getConfig 与其余新增 mock（已核实 orchestrator 删除路径）。）
 * - createSummarizeHarness：api/summarizeManualSingleRound + api/summarizeOverflowTrim
 *   （差异仅 options 字段集（lastSummaryIndex/generateContent/generateError/summarizeMaxInputRatio）
 *   与 settingsManager 键集，统一为并集；两文件本地 SUCCESS_SUMMARY 文本一致，此处导出统一值）。
 * - createCheckpointManagerHarness：checkpoint/CheckpointManifestPhase3 + CheckpointIncrementalSharing +
 *   CheckpointRestoreRules（Phase3 为超集（seedCheckpoints + setCheckpointConfig），其余为子集，
 *   调用点按原参数个数调用即可）。
 *
 * 未收敛（形状差异过大，保留在各自测试内并注明，见各文件内注释）：
 * - api/CheckpointService.test.ts（CheckpointService 专用 harness，唯一定义）；
 * - api/summarizeRestore.test.ts（liveHistory 以 getter 返回 + 动态 getHistoryRef，返回结构不同）；
 * - api/summarizeModelOverride.test.ts（useSeparateModel/summarizeModelId 位置参数 + main/dedicated 双配置）；
 * - api/toolConfirmationAbort.test.ts（overrides.executeFunctionCallsWithProgress + rejectToolCalls/
 *   toolNeedsConfirmation/drainInboxIntoResults 接线，ChatFlowService 构造参数位不同）；
 * - checkpoint/checkpointRefCountDelete.test.ts（多对话元数据 Map 形态）；
 * - checkpoint/CheckpointRetentionService.test.ts / CheckpointQueryService.test.ts（被测服务不同）；
 * - channel/toolDeclarationResolverCache.test.ts（ToolDeclarationResolver 专用 harness）。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { MessageRouter } from '../../../webview/MessageRouter';
import { WebviewClientRegistry } from '../../../webview/runtime/WebviewClientRegistry';
import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { ChatFlowService } from '../../modules/api/chat/services/ChatFlowService';
import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import { ContextTrimService } from '../../modules/api/chat/services/ContextTrimService';
import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import type { CheckpointManifest } from '../../modules/checkpoint/types';
import type { Content } from '../../modules/conversation/types';
import { isRealUserMessage } from '../../modules/conversation/helpers';
import { setGlobalBranchService } from '../../modules/conversation/branch/BranchService';
import { createPromptManagerMock } from './mockFixtures';

/** 总结文本必须 >= MIN_SUMMARY_LENGTH（50 字符），否则会被 LOW_QUALITY_SUMMARY 拒绝 */
const SUCCESS_SUMMARY: Content = {
    role: 'model',
    parts: [{ text: '已完成总结。这是足够长的总结正文：目标已记录、已完成步骤与当前进度、下一步计划与关键约束均已覆盖，供后续对话继续使用。' }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 }
};

/**
 * MessageRouter 测试 harness（webview 两个测试文件同构定义收敛）。
 * 返回 router/ctx/monitorMessages/chatHandler/conversationManager/rawSendResponse/rawSendError。
 */
export function createMessageRouterHarness() {
    const clientRegistry = new WebviewClientRegistry();
    const monitorMessages: any[] = [];
    clientRegistry.register({
        clientId: 'subagent-monitor',
        postMessage: (message: Record<string, unknown>) => {
            monitorMessages.push(message);
            return true;
        }
    });

    const chatHandler = {
        handleChatStream: jest.fn(),
        handleRetryStream: jest.fn(),
        handleToolConfirmation: jest.fn()
    };
    const conversationManager = {
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined)
    };
    const rawSendResponse = jest.fn();
    const rawSendError = jest.fn();

    const router = new MessageRouter(
        chatHandler as any,
        conversationManager as any,
        {} as any,
        () => undefined,
        rawSendResponse,
        rawSendError,
        clientRegistry
    );

    const ctx = { clientId: 'subagent-monitor' } as any;

    return {
        router,
        ctx,
        monitorMessages,
        chatHandler,
        conversationManager,
        rawSendResponse,
        rawSendError
    };
}

/**
 * ToolIterationLoopService 流式循环测试 harness（toolIterationLoopCancel + toolLoopMailboxAbort 收敛）。
 * @param channelManager 渠道 mock（generate 返回流）
 * @param toolRegistry   工具注册表（注入 ToolExecutionService）
 */
export function createToolLoopHarness(channelManager: unknown, toolRegistry: unknown) {
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        // CP-PARTIAL-1：会话元数据（工作区 URI 来源）；默认 null = 未绑定工作区，
        // 链路测试可覆盖 mockResolvedValue({ workspaceUri: 'file:///...' }) 注入工作区
        getMetadata: jest.fn().mockResolvedValue(null),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const toolExecutionService = new ToolExecutionService(toolRegistry as never);
    const checkpointService = {
        createModelMessageCheckpoint: jest.fn().mockResolvedValue(null),
        createToolExecutionCheckpoint: jest.fn().mockResolvedValue(null),
        // CPF-07：默认所有工具均视为已配置存档工具；需要模拟「纯只读/未配置」语义的测试可覆盖
        isToolConfiguredForCheckpoint: jest.fn().mockReturnValue(true)
    };
    const messageBuilderService = { buildHistoryOptions: jest.fn().mockReturnValue({}) };
    const contextTrimService = {
        getHistoryWithContextTrimInfo: jest.fn().mockResolvedValue({
            history: [],
            trimStartIndex: 0,
            needsAutoSummarize: false
        })
    };
    const toolCallParserService = {
        convertPromptModeToolCallsToFunctionCalls: jest.fn(),
        ensureFunctionCallIds: jest.fn(),
        extractFunctionCalls: jest.fn().mockImplementation((content: Content) =>
            content.parts
                .filter(p => !!p.functionCall)
                .map(p => ({
                    id: p.functionCall!.id,
                    name: p.functionCall!.name,
                    args: p.functionCall!.args
                }))
        )
    };
    const service = new ToolIterationLoopService(
        channelManager as never,
        conversationManager as never,
        toolCallParserService as never,
        messageBuilderService as never,
        {} as never,
        contextTrimService as never,
        toolExecutionService as never,
        checkpointService as never
    );
    const promptManager = createPromptManagerMock();
    service.setPromptManager(promptManager as never);
    return { service, conversationManager, contextTrimService, toolExecutionService, checkpointService, promptManager };
}

/**
 * ToolIterationLoopService 自动总结 harness（nonStreamAutoSummarizeTurn + streamAutoSummaryChunk 收敛）。
 *
 * 两种模式（二选一）：
 * - options.summarizeService：非流式模式（nonStream）——contextTrimService.getHistoryWithContextTrimInfo
 *   恒 needsAutoSummarize=true（同回合续跑计数依赖），外部注入 summarizeService；
 * - options.summarizeResult：流式模式（stream）——getHistoryWithContextTrimInfo 首调 true 后续 false
 *   （总结成功后不再触发），内部构造 getMaxAutoSummarizeAttemptsPerTurn=2 的 summarizeService。
 */
export function createAutoSummarizeToolLoopHarness(options: {
    summarizeService?: unknown;
    summarizeResult?: Record<string, unknown>;
} = {}) {
    const turnStartMessage: Content = {
        id: 'u-turn-1',
        role: 'user',
        parts: [{ text: 'question' }],
        isUserInput: true,
    };
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([turnStartMessage]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const toolExecutionService = new ToolExecutionService({} as never);
    const checkpointService = {
        createModelMessageCheckpoint: jest.fn().mockResolvedValue(null),
        createToolExecutionCheckpoint: jest.fn().mockResolvedValue(null)
    };
    const messageBuilderService = { buildHistoryOptions: jest.fn().mockReturnValue({}) };
    const contextTrimService = options.summarizeResult !== undefined
        ? {
            // 流式模式：第一轮触发总结；总结成功后重新评估不再触发
            getHistoryWithContextTrimInfo: jest
                .fn()
                .mockResolvedValueOnce({
                    history: [turnStartMessage],
                    trimStartIndex: 0,
                    needsAutoSummarize: true
                })
                .mockResolvedValue({
                    history: [turnStartMessage],
                    trimStartIndex: 0,
                    needsAutoSummarize: false
                }),
            getHistoryWithGranularFallback: jest.fn().mockResolvedValue({
                history: [turnStartMessage],
                trimStartIndex: 0,
                needsAutoSummarize: false
            })
        }
        : {
            // 非流式模式：恒 needsAutoSummarize=true（同回合续跑计数依赖）
            getHistoryWithContextTrimInfo: jest.fn().mockResolvedValue({
                history: [turnStartMessage],
                trimStartIndex: 0,
                needsAutoSummarize: true
            }),
            getHistoryWithGranularFallback: jest.fn().mockResolvedValue({
                history: [turnStartMessage],
                trimStartIndex: 0,
                needsAutoSummarize: false
            })
        };
    const toolCallParserService = {
        convertPromptModeToolCallsToFunctionCalls: jest.fn(),
        ensureFunctionCallIds: jest.fn(),
        extractFunctionCalls: jest.fn().mockReturnValue([])
    };
    const channelManager = {
        generate: jest.fn().mockResolvedValue({
            content: { role: 'model', parts: [{ text: 'final answer' }] }
        })
    };
    const summarizeService = options.summarizeService ?? {
        getMaxAutoSummarizeAttemptsPerTurn: jest.fn().mockReturnValue(2),
        handleAutoSummarize: jest.fn().mockResolvedValue(options.summarizeResult)
    };
    const service = new ToolIterationLoopService(
        channelManager as never,
        conversationManager as never,
        toolCallParserService as never,
        messageBuilderService as never,
        {} as never,
        contextTrimService as never,
        toolExecutionService as never,
        checkpointService as never
    );
    service.setPromptManager(createPromptManagerMock() as never);
    service.setSummarizeService(summarizeService as never);
    return {
        service,
        summarizeService: summarizeService as { handleAutoSummarize: jest.Mock },
        contextTrimService,
        channelManager,
        conversationManager
    };
}

/**
 * ContextTrimService harness（contextTrimValidSuffixEquivalence + contextTrimFallbackStableStart 收敛）。
 * @param historyRef 可选：getHistoryRef 的取值函数（缺省返回空历史；validSuffix 侧不调用该方法）
 */
export function createContextTrimHarness(historyRef?: () => Content[]) {
    const conversationManager = {
        getHistoryRef: jest.fn(() => Promise.resolve(historyRef ? historyRef() : [])),
        getHistoryForAPIFrom: jest.fn((contents: Content[], options: { startIndex: number }) => (
            contents.slice(options.startIndex)
        )),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn(),
        invalidateContextManagementState: jest.fn()
    };
    const promptManager = {
        getSystemPrompt: jest.fn(() => ''),
        getDynamicContextText: jest.fn(() => '')
    };
    const tokenEstimationService = {
        countTextTokensBatch: jest.fn().mockResolvedValue([0, 0]),
        preCountUserMessageTokensBatch: jest.fn().mockResolvedValue(undefined),
        estimateMessageTokens: jest.fn((message: Content) =>
            message.tokenCountByChannel?.custom ?? 100
        )
    };
    const service = new ContextTrimService(
        conversationManager as any,
        promptManager as any,
        tokenEstimationService as any,
        {} as any
    );
    return { service, conversationManager, tokenEstimationService };
}

/**
 * ChatFlowService harness（editRetryMessageId + branchHistoryDeleteSync 收敛）。
 * 默认形态 = editRetryMessageId 原定义（14 个 conversationManager mock + configManager 等）；
 * branchHistoryDeleteSync 通过 options.branchService 注入分支图 mock（harness 内 setGlobalBranchService
 * 并随返回值透出，与局部定义行为一致；handleDeleteToMessage 路径不消费其余新增 mock）。
 */
export function createChatFlowHarness(options: {
    branchService?: { syncGraphAfterHistoryDelete: jest.Mock };
} = {}) {
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue([]),
        getMessage: jest.fn().mockResolvedValue(undefined),
        getMessagesRaw: jest.fn().mockResolvedValue([]),
        getHistoryRef: jest.fn().mockResolvedValue([]),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        deleteToMessage: jest.fn().mockResolvedValue(0),
        deleteMessagesInRange: jest.fn().mockResolvedValue(undefined),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
    };
    const configManager = {
        getConfig: jest.fn().mockResolvedValue({
            enabled: true,
            type: 'custom',
            toolMode: 'function_call',
            model: 'test-model',
        }),
    };
    const diffInterruptService = {
        markUserInterrupt: jest.fn(),
        cancelAllPending: jest.fn().mockResolvedValue(undefined),
        resetUserInterrupt: jest.fn(),
    };
    const deleteCheckpointsFromIndex = jest.fn().mockResolvedValue(undefined);
    const checkpointService = {
        deleteCheckpointsFromIndex,
        runWithCheckpointDeletionLock: jest.fn(async (_conversationId: string, task: (
            deleteFromIndex: (
                startIndex: number,
                excludeCheckpointId?: string,
                lineageNodeIdsOverride?: ReadonlySet<string>
            ) => Promise<void>
        ) => Promise<unknown>) => await task(async (
            startIndex: number,
            excludeCheckpointId?: string,
            lineageNodeIdsOverride?: ReadonlySet<string>
        ) => {
            await deleteCheckpointsFromIndex(
                _conversationId,
                startIndex,
                excludeCheckpointId,
                lineageNodeIdsOverride
            );
        })),
        createUserMessageCheckpoint: jest.fn().mockResolvedValue(null),
    };
    const toolIterationLoopService = {
        clearTrimState: jest.fn().mockResolvedValue(undefined),
        runNonStreamLoop: jest.fn().mockResolvedValue({
            content: { role: 'model' as const, parts: [{ text: 'ok' }] },
            exceededMaxIterations: false,
        }),
        runToolLoop: jest.fn().mockReturnValue((async function* () { })()),
    };
    const messageBuilderService = {
        buildUserMessageParts: jest.fn().mockReturnValue([{ text: 'edited' }]),
    };
    const flowService = new ChatFlowService(
        configManager as never,
        conversationManager as never,
        undefined as never,
        messageBuilderService as never,
        {} as never,
        toolIterationLoopService as never,
        checkpointService as never,
        diffInterruptService as never,
        {} as never,
        {} as never,
    );
    if (options.branchService) {
        setGlobalBranchService(options.branchService as never);
    }
    // branchService 仅当 options.branchService 提供时非空；未提供时运行时为 undefined（消费方不访问），
    // 这里断言为非可选类型以避免调用点 strictNullChecks 报错。
    return {
        flowService,
        conversationManager,
        checkpointService,
        diffInterruptService,
        toolIterationLoopService,
        branchService: options.branchService as { syncGraphAfterHistoryDelete: jest.Mock }
    };
}

/**
 * SummarizeService harness（summarizeManualSingleRound + summarizeOverflowTrim 收敛，options 取并集）。
 * - planningHistory = historyRef ?? deep copy(fullHistory)（getHistoryRef 读「规划快照」）；
 * - mutableHistory = liveHistory ?? planningHistory（mutateContents 在「落盘历史」深拷贝上执行 mutator）；
 * - settingsManager 返回并集键（summarizePrompt + autoSummarizePrompt 均为 ''，两侧流程都不消费另一键）。
 */
export function createSummarizeHarness(options: {
    fullHistory: Content[];
    lastSummaryIndex?: number;
    maxContextTokens?: number;
    keepRecentTokens?: number | string;
    keepRecentRounds?: number;
    summarizeMaxInputRatio?: number;
    generateContent?: Content;
    generateError?: Error;
    /** 可选：getHistoryRef 返回的「规划快照」（默认 deep copy of fullHistory） */
    historyRef?: Content[];
    /** 可选：mutateContents 读写的「落盘」历史（默认与 historyRef 同一引用） */
    liveHistory?: Content[];
}) {
    const {
        fullHistory,
        lastSummaryIndex = -1,
        maxContextTokens = 1000,
        keepRecentTokens = '10%',
        keepRecentRounds = 1,
        summarizeMaxInputRatio = 0.5,
        generateContent = SUCCESS_SUMMARY,
        generateError,
        historyRef,
        liveHistory
    } = options;

    // 模拟 ConversationManager 的仓储：getHistoryRef 读「规划快照」，
    // mutateContents 在「落盘历史」的深拷贝上执行 mutator，返回新引用则写回。
    const planningHistory = historyRef ?? JSON.parse(JSON.stringify(fullHistory));
    const mutableHistory = liveHistory ?? planningHistory;

    const configManager = {
        getConfig: jest.fn(async () => ({
            id: 'cfg1',
            type: 'openai',
            enabled: true,
            maxContextTokens
        }))
    };

    // 显式标注 jest.Mock：调用点会访问 generate.mock.calls 断言入参（如 summarizeOverflowTrim L126）
    const generate: jest.Mock = jest.fn(async () => {
        if (generateError) {
            throw generateError;
        }
        return { content: generateContent };
    });

    const getHistoryRef = jest.fn(async () => planningHistory);
    const mutateContents = jest.fn(async (mutator: (history: Content[]) => Content[]) => {
        const copy = JSON.parse(JSON.stringify(mutableHistory)) as Content[];
        const next = mutator(copy);
        if (next !== copy) {
            // 有变更：写回（与仓储 saveAndReload 语义一致）
            const persisted = JSON.parse(JSON.stringify(next)) as Content[];
            mutableHistory.splice(0, mutableHistory.length, ...persisted);
            return persisted;
        }
        // 无变更：返回原引用，模拟仓储「跳过写回」
        return copy;
    });
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue(planningHistory),
        getHistoryRef,
        getTranscriptRepository: jest.fn(() => ({ mutateContents }))
    };

    const contextTrimService = {
        findLastSummaryIndex: jest.fn(() => lastSummaryIndex),
        // 真实轮数（真实实现按 isRealUserMessage 识别回合起点）：planner 放弃时
        // resolveSummarizeRange 用轮数区分 NOT_ENOUGH_CONTENT / NOT_ENOUGH_ROUNDS，
        // mock 恒返回 [] 会把单轮场景误标为 NOT_ENOUGH_CONTENT。
        identifyRounds: jest.fn((history: Content[]) => {
            const starts: number[] = [];
            for (let i = 0; i < history.length; i++) {
                if (isRealUserMessage(history[i])) starts.push(i);
            }
            return starts;
        })
    };

    const settingsManager = {
        getSummarizeConfig: jest.fn(() => ({
            keepRecentRounds,
            keepRecentTokens,
            useSeparateModel: false,
            summarizeChannelId: '',
            summarizeModelId: '',
            summarizePrompt: '',
            summarizeMaxInputRatio,
            autoSummarizePrompt: ''
        }))
    };

    const service = new SummarizeService(
        configManager as any,
        { generate } as any,
        conversationManager as any,
        contextTrimService as any,
        settingsManager as any
    );

    return { service, generate, getHistoryRef, mutateContents, liveHistory: mutableHistory };
}

/**
 * CheckpointManager 单根工作区 + mock 元数据 harness
 * （CheckpointManifestPhase3 / CheckpointIncrementalSharing / CheckpointRestoreRules 收敛，Phase3 为超集）。
 * @param seedCheckpoints 可选：初始化的元数据存档记录（Phase3 显式传，其余缺省为空）
 */
export async function createCheckpointManagerHarness(
    workspaceRoot: string,
    storageRoot: string,
    seedCheckpoints: CheckpointRecord[] = []
): Promise<{
    manager: CheckpointManager;
    storageRoot: string;
    /** 元数据中的存档记录（不含 fileHashes/fileStats 等重字段） */
    storedCheckpoints: () => CheckpointRecord[];
    /** 最近一次 getCheckpointConfig 返回值（测试可替换） */
    setCheckpointConfig: (config: Record<string, unknown>) => void;
    readManifest: (checkpointId: string) => Promise<CheckpointManifest | null>;
}> {
    (vscode.workspace as any).workspaceFolders = [
        {
            name: 'root',
            uri: { fsPath: workspaceRoot, scheme: 'file', path: workspaceRoot }
        }
    ];
    (vscode.workspace as any).textDocuments = [];
    (vscode as any).window = {
        setStatusBarMessage: jest.fn(),
        showTextDocument: jest.fn(),
        tabGroups: { all: [], close: jest.fn() }
    };
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    const sharedMetadata: { custom: Record<string, unknown> } = {
        custom: { checkpoints: [...seedCheckpoints] }
    };
    const storedCheckpoints = (): CheckpointRecord[] =>
        (sharedMetadata.custom.checkpoints as CheckpointRecord[]) || [];

    const baseConfig = {
        enabled: true,
        beforeTools: [],
        afterTools: ['write_file'],
        messageCheckpoint: { beforeMessages: [], afterMessages: [] },
        maxCheckpoints: -1,
        customIgnorePatterns: [],
        exclusion: {
            enabledProfiles: {}, // 空对象 = 全部默认类别按默认启用（全开）；测试文件（a.txt/b.txt 等）不匹配默认类别模式
            maxFileSizeBytes: 1024,
            customPatterns: []
        }
    };
    let configValue: Record<string, unknown> = { ...baseConfig };
    const settingsManager = {
        getCheckpointConfig: jest.fn().mockImplementation(() => configValue)
    };

    let metadataWriteChain: Promise<unknown> = Promise.resolve();
    const conversationManager = {
        getMetadata: jest.fn().mockImplementation(async () => sharedMetadata),
        getCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string) => {
            return (sharedMetadata.custom as Record<string, unknown>)[key];
        }),
        setCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string, value: unknown) => {
            (sharedMetadata.custom as Record<string, unknown>)[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (_cid: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
                const run = metadataWriteChain.then(async () => {
                    const current = (sharedMetadata.custom as Record<string, unknown>)[key];
                    const next = await updater(current);
                    if (next !== current) {
                        (sharedMetadata.custom as Record<string, unknown>)[key] = next;
                    }
                    return next;
                });
                metadataWriteChain = run.catch(() => undefined);
                return run;
            }
        ),
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined),
        listConversations: jest.fn().mockResolvedValue([])
    };

    const manager = new CheckpointManager(
        settingsManager as any,
        conversationManager as any,
        { globalStorageUri: { fsPath: storageRoot } } as any
    );
    await manager.initialize();

    const readManifest = async (checkpointId: string): Promise<CheckpointManifest | null> => {
        try {
            const metaRaw = await fs.readFile(
                path.join(storageRoot, 'checkpoints', checkpointId, 'manifest.json'),
                'utf-8'
            );
            const manifest = JSON.parse(metaRaw) as CheckpointManifest;
            // CPF-LAZY-1: v2 拆分布局下 files 独立存放于 files.json，按需合并读取
            if (!manifest.files) {
                try {
                    const filesRaw = await fs.readFile(
                        path.join(storageRoot, 'checkpoints', checkpointId, 'files.json'),
                        'utf-8'
                    );
                    manifest.files = (JSON.parse(filesRaw) as { files?: CheckpointManifest['files'] }).files ?? {};
                } catch {
                    manifest.files = {};
                }
            }
            return manifest;
        } catch {
            return null;
        }
    };

    return {
        manager,
        storageRoot,
        storedCheckpoints,
        setCheckpointConfig: (config: Record<string, unknown>) => {
            configValue = { ...baseConfig, ...config };
        },
        readManifest
    };
}
