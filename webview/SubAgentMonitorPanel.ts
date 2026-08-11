import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { subAgentRunController, subAgentRunEventBus, type SubAgentRunEvent, type SubAgentRunManifest, type SubAgentRunSnapshot } from '../backend/tools/subagents';
import type { SubAgentRunConversationStore } from '../backend/tools/subagents';
import { WEBVIEW_CLIENT_IDS } from './runtime/WebviewClientRegistry';
import { assertSafeId } from '../backend/core/idValidation';
import type { RunScope } from '../backend/core/RunController';
import { PUSH_MESSAGE_NAMES } from '../shared/protocol';

/**
 * Monitor 事件 payload 瘦身字段配置。
 *
 * 修改原因：事件流是跨进程传输热路径，未来新增事件时容易无意带上长正文或工具大结果。
 * 修改方式：safe keys 使用小白名单，大字段使用显式黑名单提前剥离；真正正文继续走 getRunWindow。
 * 修改目的：让状态事件保持轻量，并把大对象防护集中在一个 helper 周围。
 */
const MONITOR_EVENT_PAYLOAD_SAFE_KEYS = new Set([
    'attempt',
    'maxAttempts',
    'error',
    'nextRetryIn',
    'status',
    'steps',
    'modelVersion',
    'duration',
    'contentCount',
    'deltaCount',
    'done',
    'toolName',
    'toolId',
    'name',
    'id',
    // 修改原因：Monitor 事件与窗口响应已经异步解耦，payload 白名单必须允许协议版本字段透传给前端。
    // 修改方式：把 contentRevision/eventSequence 纳入小字段白名单，仍然禁止 contents/response/result 等大对象。
    // 修改目的：前端可用单调字段拒绝 stale delta 和旧窗口响应，而不回退到 full snapshot。
    'contentRevision',
    'eventSequence'
]);

const MONITOR_EVENT_PAYLOAD_BIG_KEYS = new Set([
    'response',
    'content',
    'contents',
    'parts',
    'text',
    'data',
    'result'
]);

function sanitizeMonitorPayloadValue(value: unknown): unknown {
    // 修改原因：未来新增事件可能在嵌套字段里夹带 response/content/data/result 等大正文，不能只处理已知事件名。
    // 修改方式：递归白名单复制对象字段，遇到已知大字段直接丢弃，数组仅保留长度摘要。
    // 修改目的：事件通道只承载状态和计数，正文统一由 getRunWindow 拉取，避免新增事件悄悄破坏优化边界。
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return { count: value.length };
    if (typeof value !== 'object') return undefined;

    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (MONITOR_EVENT_PAYLOAD_BIG_KEYS.has(key)) {
            if (Array.isArray(nestedValue)) {
                sanitized[`${key}Count`] = nestedValue.length;
            }
            continue;
        }
        if (!MONITOR_EVENT_PAYLOAD_SAFE_KEYS.has(key)) {
            continue;
        }
        const next = sanitizeMonitorPayloadValue(nestedValue);
        if (next !== undefined) {
            sanitized[key] = next;
        }
    }
    return sanitized;
}

function cloneJsonSafeValue(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

/** functionCall 参数字符串/对象超长时截断为首尾摘要，防止工具大参数经事件通道全量传输（F19） */
function truncateFunctionCallArgs(value: unknown): unknown {
    const MAX_ARGS_LENGTH = 2000;
    const HEAD_LENGTH = 1200;
    const TAIL_LENGTH = MAX_ARGS_LENGTH - HEAD_LENGTH - 1; // 1 个省略符
    if (typeof value === 'string') {
        if (value.length <= MAX_ARGS_LENGTH) return value;
        return `${value.slice(0, HEAD_LENGTH)}…${value.slice(-TAIL_LENGTH)}`;
    }
    if (typeof value === 'object' && value !== null) {
        try {
            const json = JSON.stringify(value);
            if (json.length > MAX_ARGS_LENGTH) {
                return `${json.slice(0, HEAD_LENGTH)}…${json.slice(-TAIL_LENGTH)}`;
            }
        } catch {
            // 序列化失败保持原值
        }
    }
    return value;
}

function sanitizeLlmDeltaPart(part: unknown): Record<string, unknown> | undefined {
    if (!part || typeof part !== 'object') return undefined;
    const source = part as Record<string, any>;

    if (typeof source.text === 'string') {
        const textPart: Record<string, unknown> = { text: source.text };
        if (source.thought === true) textPart.thought = true;
        return textPart;
    }

    if (source.functionCall && typeof source.functionCall === 'object') {
        const fc = source.functionCall as Record<string, unknown>;
        const safeFunctionCall: Record<string, unknown> = {};
        for (const key of ['id', 'name', 'args', 'partialArgs', 'index', 'itemId', 'finalArgs', 'rejected']) {
            if (!(key in fc)) continue;
            let cloned = cloneJsonSafeValue(fc[key]);
            if (cloned !== undefined) {
                // args/partialArgs/finalArgs 是工具调用参数，可能携带完整大对象/长 JSON，
                // 统一截断为摘要（F19）
                if (key === 'args' || key === 'partialArgs' || key === 'finalArgs') {
                    cloned = truncateFunctionCallArgs(cloned);
                }
                safeFunctionCall[key] = cloned;
            }
        }
        return Object.keys(safeFunctionCall).length > 0
            ? { functionCall: safeFunctionCall }
            : undefined;
    }

    return undefined;
}

function createLlmDeltaPayload(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): Record<string, unknown> {
    const rawPayload = (event.payload || {}) as Record<string, any>;
    const rawDelta = Array.isArray(rawPayload.delta) ? rawPayload.delta : [];
    const delta = rawDelta
        .map(sanitizeLlmDeltaPart)
        .filter((part): part is Record<string, unknown> => !!part);

    const payload: Record<string, unknown> = {
        deltaCount: rawDelta.length,
        contentCount: rawPayload.contentSnapshot ? 1 : undefined,
        done: rawPayload.done === true,
        modelVersion: rawPayload.modelVersion,
        thinkingStartTime: rawPayload.thinkingStartTime,
        usage: cloneJsonSafeValue(rawPayload.usage),
        // 修改原因：llm_delta 需要轻量正文 delta 才能满足 Monitor 实时显示，但不能重新携带完整 snapshot.contents 或工具大结果。
        // 修改方式：只白名单 text/thought/functionCall 增量字段；contentSnapshot 继续只以计数提示窗口校准。
        // 修改目的：保持“实时正文走轻量 delta，大对象走 getRunWindow”的统一协议边界。
        delta: delta.length > 0 ? delta : undefined,
        contentRevision: snapshot.contentRevision,
        eventSequence: snapshot.eventSequence
    };

    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) {
            delete payload[key];
        }
    }
    return payload;
}

export function createMonitorEventPayload(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): SubAgentRunEvent {
    // 修改原因：Monitor 的 postMessage 事件流是热路径，不能传输完整 transcript、模型长回答或工具大结果。
    // 修改方式：所有事件统一经过白名单/瘦身 helper；content_snapshot 只发 contentCount，run_completed 不发 response，未知事件也剥离大字段。
    // 修改目的：把“事件只承载状态，正文走 window”固化为单一入口，防止未来新增事件再次夹带大 payload。
    const payload = sanitizeMonitorPayloadValue(event.payload) as Record<string, unknown> | undefined;
    const nextPayload: Record<string, unknown> | undefined = payload && typeof payload === 'object'
        ? { ...payload }
        : undefined;

    if (event.type === 'content_snapshot') {
        return {
            ...event,
            payload: {
                contentCount: snapshot.contents?.length || 0,
                // 修改原因：content_snapshot 是前端强制校准窗口的边界事件，必须携带当前 transcript 修订号。
                // 修改方式：从 snapshot 下发 contentRevision/eventSequence，不携带完整 contents。
                // 修改目的：让前端能判断本地 window 是否过期，并避免把下一轮 delta 追加到旧 model 楼层。
                contentRevision: snapshot.contentRevision,
                eventSequence: snapshot.eventSequence
            }
        };
    }

    if (event.type === 'llm_delta') {
        return {
            ...event,
            payload: createLlmDeltaPayload(event, snapshot)
        };
    }

    return {
        ...event,
        payload: nextPayload
    };
}

/**
 * SubAgent Monitor 编辑器面板。
 * 内部过程进入独立 WebviewPanel，不污染主聊天时间线；前端通过 view mode 切换到 Monitor UI。
 */
export class SubAgentMonitorPanel {
    private panel?: vscode.WebviewPanel;
    private focusRunId?: string;
    private focusConversationId?: string;
    /** 面板可见性（前端通过 subagents.monitor.setVisible 上报，用于折叠时丢弃 llm_delta） */
    private visible = true;
    private readonly unsubscribe: () => void;
    private clientRegistration?: vscode.Disposable;
    /**
     * 当前面板实例的事件订阅。
     *
     * 修改原因：过去把 onDidReceiveMessage / onDidDispose 注册到 context.subscriptions，
     *          那个数组的生命周期是整个扩展，面板关闭后这些已失效的订阅不会被移除，
     *          反复开关 Monitor 会持续累积。
     * 修改方式：改为面板级数组，onDidDispose 时一次性清空。
     * 修改目的：订阅生命周期与面板实例严格对齐。
     */
    private panelDisposables: vscode.Disposable[] = [];

    /**
     * manifest 缓存：事件推送复用同一 manifest，直到对应 run 的 updatedAt 变化（F20）。
     *
     * 修改原因：每个事件都重新调用 getManifest/getActiveRunIds 会在高频 llm_delta 下
     *          重复派生轻量 manifest 与拷贝活跃 id 数组。
     * 修改方式：manifest 按 runId 缓存，updatedAt 未变化时直接复用。
     * 修改目的：事件热路径只付出一次派生成本。
     *
     * 容量上限：run 结束后条目长期驻留（仅 run 被清理 / 面板 dispose 时才删除），
     *           长时间运行下面板缓存无界增长；超上限按插入序 FIFO 淘汰最旧条目。
     */
    private static readonly MANIFEST_CACHE_MAX = 64;
    private readonly manifestCache = new Map<string, { manifest: SubAgentRunManifest; updatedAt: number }>();

    /**
     * llm_delta 节流合并队列。
     *
     * 修改原因：流式输出时每个 chunk 都触发一次跨进程 postMessage，高频输出（每秒数十 chunk）会让
     *          Webview 通道和前端事件处理持续满载，Monitor 即使只有一个 run 也会卡顿。
     * 修改方式：llm_delta 先按 run 入队，由短定时器批量合并后一次性 postMessage；run 状态等低频事件不受影响。
     * 修改目的：postMessage 次数与渲染帧率对齐，而不是与 token 产出速度对齐。
     */
    private readonly pendingLlmDeltaEvents = new Map<string, SubAgentRunEvent[]>();
    private llmDeltaFlushTimer?: ReturnType<typeof setTimeout>;
    private static readonly LLM_DELTA_FLUSH_MS = 50;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly devServerUrl?: string,
        private readonly routeMessage?: (message: any, webview: vscode.Webview) => Promise<boolean>,
        private readonly registerClient?: (clientId: string, webview: vscode.Webview, runScope?: RunScope, isAlive?: () => boolean) => vscode.Disposable,
        private readonly conversationStore?: SubAgentRunConversationStore
    ) {
        this.unsubscribe = subAgentRunEventBus.subscribe((event, snapshot) => {
            this.postEvent(event, snapshot);
        });
    }

    /**
     * 统一注册 monitor 面板的 webview client（open/reveal 共用）。
     * isAlive 绑定当前 panel 实例：面板销毁后路由立即判定失败，走回退路径（F4/M8）。
     */
    private registerPanelClient(runId?: string, conversationId?: string): void {
        if (!this.panel) return;
        const webview = this.panel.webview;
        this.clientRegistration?.dispose();
        this.clientRegistration = this.registerClient?.(
            WEBVIEW_CLIENT_IDS.subagentMonitor,
            webview,
            runId ? { type: 'subagent', runId, parentConversationId: conversationId } : undefined,
            () => this.panel !== undefined && this.panel.webview === webview
        );
    }

    open(runId?: string, conversationId?: string): void {
        this.focusRunId = runId;
        this.focusConversationId = conversationId;

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            this.registerPanelClient(runId, conversationId);
            // 修改原因：已有面板被再次 reveal 时，旧实现会重新推送完整 snapshots，导致大 transcript 二次卡顿。
            // 修改方式：只推送轻量 manifest，同步焦点后由前端按需请求当前 run window。
            // 修改目的：Monitor 任何首包/重聚焦包都不再携带所有 contents。
            this.postManifest();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'graycode.subAgentMonitor',
            'SubAgent Monitor',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist')),
                    // 内置资源（codicons 图标字体等）
                    vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))
                ]
            }
        );

        this.registerPanelClient(runId, conversationId);

        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(message => {
            this.handleMessage(message).catch(error => {
                // 修改原因：处理器抛异常时旧实现只打日志，带 requestId 的请求便永远收不到回复——
                //          前端那个 Promise 永久 pending，"加载更早消息"之类的 loading 状态再也不会结束。
                // 修改方式：异常统一转成错误响应回传，与主聊天 ChatViewProvider 的路由保底行为一致。
                // 修改目的：任何一次请求都有终结状态，失败也是终结。
                console.error('[SubAgentMonitorPanel] Failed to handle webview message:', error);
                const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
                if (!requestId) return;
                this.postRoutedMessage({
                    type: PUSH_MESSAGE_NAMES.error,
                    requestId,
                    success: false,
                    error: {
                        code: 'SUBAGENT_MONITOR_HANDLER_ERROR',
                        message: error instanceof Error ? error.message : String(error)
                    }
                }, this.resolveClientId(message));
            });
        }, undefined, this.panelDisposables);

        // 修改原因：面板切到后台标签页期间高频 llm_delta 被主动丢弃（见 postEvent），窗口内容会停在当时的修订号。
        // 修改方式：重新可见时补推一次 manifest，前端据此发现窗口落后并自行拉取权威窗口。
        // 修改目的：不可见期间零推送成本，恢复可见后仍然与后端 transcript 一致。
        this.panel.onDidChangeViewState(() => {
            if (this.panel?.visible) {
                this.postManifest({ navigate: false });
                // 可见性恢复时同步补推一次焦点状态，覆盖 webview 首次加载前消息丢失的场景
                pushWindowFocus(vscode.window.state.focused);
            }
        }, undefined, this.panelDisposables);

        // VSCode 窗口焦点状态推送：子代理面板启用提示音后，需要与主窗口同一套焦点感知——
        // 焦点在 VSCode 窗口时用户看得见界面，不播；窗口失焦（切到其他应用）时才播提醒。
        const pushWindowFocus = (focused: boolean) => {
            this.postRoutedMessage({
                type: PUSH_MESSAGE_NAMES.command,
                command: PUSH_MESSAGE_NAMES.windowFocusChanged,
                data: { focused: !!focused }
            });
        };
        pushWindowFocus(vscode.window.state.focused);
        this.panelDisposables.push(
            vscode.window.onDidChangeWindowState((state) => {
                pushWindowFocus(state.focused);
            })
        );

        this.panel.onDidDispose(() => {
            this.clearLlmDeltaQueue();
            this.clientRegistration?.dispose();
            this.clientRegistration = undefined;
            this.panel = undefined;
            for (const disposable of this.panelDisposables.splice(0)) {
                disposable.dispose();
            }
        }, undefined, this.panelDisposables);
    }

    dispose(): void {
        this.unsubscribe();
        this.clearLlmDeltaQueue();
        this.manifestCache.clear();
        this.clientRegistration?.dispose();
        this.clientRegistration = undefined;
        this.panel?.dispose();
        this.panel = undefined;
        for (const disposable of this.panelDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private resolveClientId(message: any): string {
        return typeof message?.clientId === 'string' && message.clientId.trim()
            ? message.clientId.trim()
            : WEBVIEW_CLIENT_IDS.subagentMonitor;
    }

    private async handleMessage(message: any): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const clientId = this.resolveClientId(message);

        if (message.type === 'subagents.monitorReady') {
            // 修改原因：monitorReady 是打开 Monitor 的首包，不能继续返回包含完整 contents 的 snapshots。
            // 修改方式：返回由事件总线从 snapshot 派生的 manifests；Content[] 仅通过 getRunWindow 按 run 拉取。
            // 修改目的：大输出不会在首屏阶段进入 stringify/postMessage/deserialize/Vue state/Markdown 渲染链路。
            await this.loadConversationSnapshotsIfPossible(this.focusConversationId);
            this.postRoutedMessage({
                type: PUSH_MESSAGE_NAMES.response,
                requestId: message.requestId,
                success: true,
                data: this.createManifestPayload(true)
            }, clientId);
            // 补推一次窗口焦点：open() 时的推送可能早于前端监听器注册（面板无 ready 队列），
            // 前端若停在默认 focused=true，失焦场景的提示音会失效直到下次焦点变化。
            this.postRoutedMessage({
                type: PUSH_MESSAGE_NAMES.command,
                command: PUSH_MESSAGE_NAMES.windowFocusChanged,
                data: { focused: !!vscode.window.state.focused }
            });
            return;
        }

        if (message.type === 'subagents.monitor.getRunWindow') {
            const runId = typeof message.data?.runId === 'string' ? message.data.runId.trim() : '';
            if (!runId) {
                this.postRoutedMessage({
                    type: PUSH_MESSAGE_NAMES.error,
                    requestId: message.requestId,
                    success: false,
                    error: { code: 'SUBAGENT_MONITOR_WINDOW_INVALID_INPUT', message: 'runId is required' }
                }, clientId);
                return;
            }

            // 修改原因：历史 run 可能来自 conversation metadata，打开窗口前需先恢复到事件总线，但不能把恢复后的完整 snapshot 推给前端。
            // 修改方式：若请求带 conversationId 或当前面板有 focusConversationId，先加载 metadata，再只返回指定 run 的窗口。
            // 修改目的：兼容历史 Monitor 查看，同时保持按需加载边界。
            await this.loadConversationSnapshotsIfPossible(
                typeof message.data?.conversationId === 'string' ? message.data.conversationId : this.focusConversationId
            );
            await subAgentRunEventBus.loadRunTranscript(runId);
            const contentWindow = subAgentRunEventBus.getContentWindow(runId, message.data?.options || {});
            if (!contentWindow) {
                this.postRoutedMessage({
                    type: PUSH_MESSAGE_NAMES.error,
                    requestId: message.requestId,
                    success: false,
                    error: { code: 'SUBAGENT_RUN_NOT_FOUND', message: `SubAgent run not found: ${runId}` }
                }, clientId);
                return;
            }
            this.postRoutedMessage({
                type: PUSH_MESSAGE_NAMES.response,
                requestId: message.requestId,
                success: true,
                data: {
                    window: contentWindow,
                    manifest: subAgentRunEventBus.getManifest(runId),
                    activeRunIds: subAgentRunController.getActiveRunIds()
                }
            }, clientId);
            return;
        }

        if (message.type === 'subagents.monitor.setVisible') {
            // 修改原因：与 Electron 版行为对齐（SubAgentMonitorBridge.ts 125-134）。
            // 修改方式：维护面板可见性状态并回执；隐藏时前端停止推送 llm_delta，
            //          避免折叠面板仍持续接收高频流式增量。
            // 修改目的：嵌入模式下“隐藏时丢弃 llm_delta”的优化真正生效。
            this.visible = message.data?.visible === true;
            this.postRoutedMessage({
                type: 'response',
                requestId: message.requestId,
                success: true,
                data: { visible: this.visible }
            }, clientId);
            return;
        }

        if (this.routeMessage && this.panel) {
            // 非 lifecycle 消息委托给主聊天统一 MessageRouter，避免 Monitor 复制 handler 或让 diff/tool 操作 pending。
            const handled = await this.routeMessage(message, this.panel.webview);
            if (!handled && message.requestId) {
                this.postRoutedMessage({
                    type: PUSH_MESSAGE_NAMES.error,
                    requestId: message.requestId,
                    success: false,
                    error: {
                        code: 'UNKNOWN_TYPE',
                        message: `Unknown message type: ${message.type}`
                    }
                }, clientId);
            }
        }
    }

    // clientId 来自前端消息，是任意字符串；默认值只是缺省归属，不应把参数收窄成该字面量类型
    private postRoutedMessage(message: Record<string, any>, clientId: string = WEBVIEW_CLIENT_IDS.subagentMonitor): void {
        this.panel?.webview.postMessage({
            ...message,
            clientId
        });
    }

    /** 获取（并按需重建）指定 run 的轻量 manifest：updatedAt 未变化时直接复用缓存（F20） */
    private getCachedManifest(runId: string): SubAgentRunManifest | undefined {
        const manifest = subAgentRunEventBus.getManifest(runId);
        // manifest 可能为 undefined（run 尚未加载/已被清理）：不走缓存，直接返回（F21）
        if (!manifest) {
            // 顺带清理可能残留的过期缓存条目，避免后续同一 runId 复用陈旧 updatedAt
            this.manifestCache.delete(runId);
            return undefined;
        }
        const cached = this.manifestCache.get(runId);
        if (cached && cached.updatedAt === manifest.updatedAt) {
            return cached.manifest;
        }
        this.manifestCache.set(runId, { manifest, updatedAt: manifest.updatedAt });
        // 容量上限：超出时按插入序淘汰最旧条目（Map 迭代序 = 插入序）
        if (this.manifestCache.size > SubAgentMonitorPanel.MANIFEST_CACHE_MAX) {
            const oldestRunId = this.manifestCache.keys().next().value;
            if (oldestRunId !== undefined) {
                this.manifestCache.delete(oldestRunId);
            }
        }
        return manifest;
    }

    private postEvent(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): void {
        // 修改原因：事件总线订阅在面板关闭后依然存在，旧实现对每个 llm_delta 都完整执行 payload 清洗、
        //          manifest 派生和 activeRunIds 收集，然后在 postRoutedMessage 里因为没有 panel 被整个丢弃。
        // 修改方式：没有活跃面板时直接短路，不构造任何事件载荷。
        // 修改目的：Monitor 未打开时，SubAgent 流式输出不再为不可见的 UI 支付逐 chunk 的序列化成本。
        if (!this.panel) {
            return;
        }
        // 修改原因：retainContextWhenHidden 让面板切到后台标签页后依然存在，于是 SubAgent 的每个流式 chunk
        //          仍要走一遍 payload 清洗、manifest 派生、序列化和 postMessage，最终画在一个用户看不见的 UI 上。
        // 修改方式：不可见时只丢弃高频正文增量；run 状态、工具状态等低频事件继续推送，成本可忽略且能让面板一回到前台就是最新状态。
        // 修改目的：Monitor 开着但不在前台时，子代理输出不再为不可见的界面付出逐 chunk 的传输代价。
        if (!this.panel.visible && event.type === 'llm_delta') {
            return;
        }
        // 修改原因：高频 llm_delta 不能每 chunk 都 postMessage，否则 Webview 通道和前端事件处理会被流式输出打满。
        // 修改方式：llm_delta 入队后由 LLM_DELTA_FLUSH_MS 定时器批量合并发送；其它事件保持即时。
        // 修改目的：跨进程消息频率与帧率对齐，Monitor 在密集输出下依然流畅。
        if (event.type === 'llm_delta') {
            this.enqueueLlmDelta(event);
            return;
        }
        this.postRoutedMessage({
            type: PUSH_MESSAGE_NAMES['subagentMonitor.event'],
            data: {
                event: createMonitorEventPayload(event, snapshot),
                // 修改原因：无论高频 llm_delta 还是低频 content_snapshot/run_completed，都不能再附完整 snapshot.contents。
                // 修改方式：事件推送只携带轻量 manifest；当前聚焦 run 需要校准内容时由前端 getRunWindow 拉窗口。
                // 修改目的：避免 Monitor 打开后任一低频事件再次把大 transcript 全量送入前端。
                manifest: this.getCachedManifest(snapshot.runId),
                focusRunId: this.focusRunId,
                focusConversationId: this.focusConversationId,
                // 控制按钮可见性以后端活跃运行控制器为准，不让前端猜测 run 是否仍活跃。
                activeRunIds: subAgentRunController.getActiveRunIds()
            }
        });
    }

    private enqueueLlmDelta(event: SubAgentRunEvent): void {
        const list = this.pendingLlmDeltaEvents.get(event.runId);
        if (list) {
            list.push(event);
        } else {
            this.pendingLlmDeltaEvents.set(event.runId, [event]);
        }
        if (!this.llmDeltaFlushTimer) {
            this.llmDeltaFlushTimer = setTimeout(() => this.flushLlmDeltas(), SubAgentMonitorPanel.LLM_DELTA_FLUSH_MS);
            // 节流窗口不应成为进程存活理由
            (this.llmDeltaFlushTimer as { unref?: () => void }).unref?.();
        }
    }

    private flushLlmDeltas(): void {
        this.llmDeltaFlushTimer = undefined;
        if (!this.panel || !this.panel.visible || this.pendingLlmDeltaEvents.size === 0) {
            this.pendingLlmDeltaEvents.clear();
            return;
        }
        const batches = Array.from(this.pendingLlmDeltaEvents.entries());
        this.pendingLlmDeltaEvents.clear();

        for (const [runId, events] of batches) {
            const snapshot = subAgentRunEventBus.getSnapshot(runId);
            if (!snapshot) continue;
            // 合并：delta 数组按序拼接，contentSnapshot/usage/done 等状态字段取最后一个事件的值
            const last = events[events.length - 1];
            const lastPayload = (last.payload || {}) as Record<string, unknown>;
            const mergedPayload: Record<string, unknown> = { ...lastPayload };
            const deltaParts: unknown[] = [];
            for (const event of events) {
                const rawDelta = (event.payload as Record<string, unknown> | undefined)?.delta;
                if (Array.isArray(rawDelta)) {
                    deltaParts.push(...rawDelta);
                }
            }
            if (deltaParts.length > 0) {
                mergedPayload.delta = deltaParts;
            }
            const mergedEvent: SubAgentRunEvent = {
                ...last,
                runId,
                payload: mergedPayload
            };
            this.postRoutedMessage({
                type: PUSH_MESSAGE_NAMES['subagentMonitor.event'],
                data: {
                    event: createMonitorEventPayload(mergedEvent, snapshot),
                    // 修改原因：无论高频 llm_delta 还是低频 content_snapshot/run_completed，都不能再附完整 snapshot.contents。
                    // 修改方式：事件推送只携带轻量 manifest；当前聚焦 run 需要校准内容时由前端 getRunWindow 拉窗口。
                    // 修改目的：避免 Monitor 打开后任一低频事件再次把大 transcript 全量送入前端。
                    manifest: this.getCachedManifest(runId),
                    focusRunId: this.focusRunId,
                    focusConversationId: this.focusConversationId,
                    // 控制按钮可见性以后端活跃运行控制器为准，不让前端猜测 run 是否仍活跃。
                    activeRunIds: subAgentRunController.getActiveRunIds()
                }
            });
        }
    }

    private clearLlmDeltaQueue(): void {
        if (this.llmDeltaFlushTimer) {
            clearTimeout(this.llmDeltaFlushTimer);
            this.llmDeltaFlushTimer = undefined;
        }
        this.pendingLlmDeltaEvents.clear();
    }

    private async loadConversationSnapshotsIfPossible(conversationId?: string): Promise<void> {
        if (!conversationId || !this.conversationStore) {
            return;
        }
        // 修改原因：Monitor 面板自身不拥有 ConversationManager，但历史子 run 需要从父 conversation metadata 恢复。
        // 修改方式：ChatViewProvider 构造时注入 conversationStore seam；这里仅按 conversationId 恢复到事件总线。
        // 修改目的：不在 MessageRouter 写 endpoint 特判，也不新增 Monitor 独立状态真源。
        // conversationId 来自消息层，进存储前必须校验（存储层也有兜底，这里提前给出友好错误）。
        assertSafeId(conversationId, 'conversationId');
        await subAgentRunEventBus.loadConversationSnapshots(conversationId, this.conversationStore);
    }

    /**
     * @param navigate 是否携带导航意图。true 表示"用户从主聊天打开了某个 run"，前端会据此切换焦点；
     *                 false 用于纯状态同步（如面板重新可见），不得覆盖用户在 Monitor 内手动选中的 run。
     */
    private createManifestPayload(navigate: boolean): Record<string, any> {
        return {
            manifests: subAgentRunEventBus.getManifests(),
            focusRunId: navigate ? this.focusRunId : undefined,
            focusConversationId: this.focusConversationId,
            // 历史 run 只允许查看；控制按钮以仍有主工具 Promise 等待的 activeRunIds 为准。
            activeRunIds: subAgentRunController.getActiveRunIds()
        };
    }

    private postManifest(options: { navigate: boolean } = { navigate: true }): void {
        this.postRoutedMessage({
            type: PUSH_MESSAGE_NAMES['subagentMonitor.manifest'],
            data: this.createManifestPayload(options.navigate)
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist', 'index.js'))
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist', 'index.css'))
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'codicons', 'codicon.css'))
        );

        const devServerUrl = this.devServerUrl;
        const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
        const nonce = randomBytes(16).toString('base64');
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} https: data:`,
            `font-src ${webview.cspSource}`,
            `style-src ${webview.cspSource} 'unsafe-inline' ${devServerOrigin || ''}`,
            `script-src ${webview.cspSource} 'nonce-${nonce}' ${devServerOrigin || ''}`,
            `connect-src ${devServerOrigin || ''}`
        ].join('; ');
        // 内联 JSON 必须转义 < 防止 </script> 提前闭合注入（focusRunId 来自消息层，不可信）
        const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
        const bootstrap = `<script nonce="${nonce}">window.__GRAYCODE_VIEW_MODE = 'subagentMonitor'; window.__GRAYCODE_WEBVIEW_CLIENT_ID = ${safeJson(WEBVIEW_CLIENT_IDS.subagentMonitor)}; window.__GRAYCODE_INITIAL_RUN_ID = ${safeJson(this.focusRunId || null)};</script>`;

        if (devServerUrl) {
            return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${codiconsUri}" rel="stylesheet">
  ${bootstrap}
  <title>SubAgent Monitor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${devServerUrl}/@vite/client"></script>
  <script nonce="${nonce}" type="module" src="${devServerUrl}/src/main.ts"></script>
</body>
</html>`;
        }

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
  ${bootstrap}
  <title>SubAgent Monitor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
