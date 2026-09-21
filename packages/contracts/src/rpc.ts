import type { DirectoryEntry, SettingsDraft, SettingsSnapshot } from './settings';
import type { FileEntryInfo } from './files';
import type { RunEvent, RunRecord, ModelRequestMetrics } from './runtime';
import type { RuntimeDiagnostics } from './remote';
import type { ComputerAction, ComputerObservation, ComputerObserveInput, ComputerOperation, ComputerStatus, ComputerWindows } from './computer';
import type { BrowserLayout, BrowserProfile, BrowserState, BrowserTab } from './browser';
import type { VisualActionResult } from './visual';

export interface ModelRequestSnapshot {
  runId: string; iteration: number; capturedAt: number; protocol: string; model: string; body: unknown;
  turnContext?: { characterTurn?: { resources: unknown; activation: unknown; config: unknown } };
  prefix?: Record<string, unknown>;
  metrics?: ModelRequestMetrics;
}
type Method<P, R> = { params: P; result: R };
type Empty = Record<string, never>;
type FilePath = { workspaceId: string; path: string };
type TabId = { tabId: string };
export type BrowserControlAction = 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'devtools';

/** 每个领域只在这里声明参数和返回值，桌面与 Web 共用同一调用签名。 */
export interface RpcMethods {
  'diagnostics.get': Method<Empty, RuntimeDiagnostics>;
  'settings.get': Method<Empty, SettingsSnapshot>;
  'settings.save': Method<SettingsDraft, SettingsSnapshot>;
  'files.list': Method<{ workspaceId: string; path?: string }, DirectoryEntry[]>;
  'files.inspect': Method<FilePath, FileEntryInfo>;
  'files.downloadInfo': Method<FilePath, { name: string; size: number; mimeType: string }>;
  'files.download': Method<FilePath, unknown>;
  'files.create': Method<FilePath & { kind: 'file' | 'directory' }, FileEntryInfo>;
  'files.move': Method<FilePath & { target: string; expectedVersion: string }, FileEntryInfo>;
  'files.remove': Method<FilePath & { expectedVersion: string; recursive?: boolean }, void>;
  'files.upload': Method<FilePath & { expectedVersion: string; bytes: Uint8Array }, FileEntryInfo>;
  'runs.start': Method<{ conversationId: string; requestKey: string; agentId: string; text: string; workspaceId?: string;
    providerId?: string; modelOverride?: string; reasoningEffort?: string }, RunRecord>;
  'runs.list': Method<{ conversationId?: string; activeOnly?: boolean }, RunRecord[]>;
  'runs.events': Method<{ id: string; afterSequence?: number }, RunEvent[]>;
  'runs.request': Method<{ id: string; iteration: number }, ModelRequestSnapshot | null>;
  'runs.cancel': Method<{ id: string }, void>;
  'approvals.resolve': Method<{ id: string; accepted: boolean; choiceId?: string }, void>;
  'computer.status': Method<Empty, ComputerStatus>;
  'computer.windows': Method<Empty, ComputerWindows>;
  'computer.observe': Method<ComputerObserveInput, ComputerObservation>;
  'computer.acquire': Method<{ windowIds: string[] }, ComputerStatus>;
  'computer.action': Method<ComputerAction & { operationId: string }, VisualActionResult & { windowId: string }>;
  'computer.stop': Method<Empty, ComputerStatus>;
  'computer.release': Method<Empty, ComputerStatus>;
  'computer.recent': Method<Empty, ComputerOperation[]>;
  'computer.allowRun': Method<{ runId: string }, { success: boolean }>;
  'browser.state': Method<Empty, BrowserState>;
  'browser.layout': Method<BrowserLayout, void>;
  'browser.profile.create': Method<{ name: string }, BrowserProfile>;
  'browser.profile.rename': Method<{ id: string; name: string }, void>;
  'browser.newTab': Method<{ profileId?: string; url?: string }, BrowserTab>;
  'browser.open': Method<{ url: string; tabId?: string; profileId?: string }, BrowserTab | { success: boolean }>;
  'browser.openFile': Method<FilePath, BrowserTab | { success: boolean }>;
  'browser.control': Method<{ action: BrowserControlAction; tabId?: string; url?: string }, BrowserTab>;
  'browser.select': Method<TabId, BrowserTab>;
  'browser.takeover': Method<TabId, BrowserTab>;
  'browser.allowAutomation': Method<TabId, BrowserTab>;
  'browser.closeTab': Method<TabId, BrowserState>;
}
export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];
export type RpcArguments<M extends RpcMethod> = {} extends RpcParams<M> ? [params?: RpcParams<M>] : [params: RpcParams<M>];
export type RpcCall = <M extends RpcMethod>(method: M, ...args: RpcArguments<M>) => Promise<RpcResult<M>>;
export type RpcHandler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;

type Check = { accepts: (value: unknown) => boolean; optional?: true };
const text: Check = { accepts: value => typeof value === 'string' };
const number: Check = { accepts: value => typeof value === 'number' && Number.isFinite(value) };
const boolean: Check = { accepts: value => typeof value === 'boolean' };
const object: Check = { accepts: value => !!value && typeof value === 'object' && !Array.isArray(value) };
const strings: Check = { accepts: value => Array.isArray(value) && value.every(item => typeof item === 'string') };
const optional = (check: Check): Check => ({ ...check, optional: true });
const oneOf = (...values: string[]): Check => ({ accepts: value => typeof value === 'string' && values.includes(value) });
const file = { workspaceId: text, path: text };
const tab = { tabId: text };

// 字段表受方法参数类型约束；新增字段时，遗漏入口检查会触发编译错误。
const checks: { [M in RpcMethod]: { [K in keyof RpcParams<M>]-?: Check } } = {
  'diagnostics.get': {},
  'settings.get': {}, 'settings.save': { settings: object, expectedRevision: number, credentials: optional(object) },
  'files.list': { workspaceId: text, path: optional(text) }, 'files.inspect': file, 'files.downloadInfo': file, 'files.download': file,
  'files.create': { ...file, kind: oneOf('file', 'directory') },
  'files.move': { ...file, target: text, expectedVersion: text },
  'files.remove': { ...file, expectedVersion: text, recursive: optional(boolean) },
  'files.upload': { ...file, expectedVersion: text, bytes: { accepts: value => value instanceof Uint8Array } },
  'runs.start': { conversationId: text, requestKey: text, agentId: text, text, workspaceId: optional(text),
    providerId: optional(text), modelOverride: optional(text), reasoningEffort: optional(text) },
  'runs.list': { conversationId: optional(text), activeOnly: optional(boolean) },
  'runs.events': { id: text, afterSequence: optional(number) }, 'runs.request': { id: text, iteration: number }, 'runs.cancel': { id: text },
  'approvals.resolve': { id: text, accepted: boolean, choiceId: optional(text) },
  'computer.status': {}, 'computer.windows': {}, 'computer.stop': {}, 'computer.release': {}, 'computer.recent': {},
  'computer.allowRun': { runId: text }, 'computer.acquire': { windowIds: strings },
  'computer.observe': { windowId: text, screenshot: optional(boolean), maxElements: optional(number), maxDepth: optional(number),
    width: optional(number), height: optional(number), frameOnly: optional(boolean), windowOnly: optional(boolean),
    expectedProcess: optional(object), format: optional(oneOf('png', 'jpeg')), quality: optional(number) },
  'computer.action': { observationId: text, operationId: text,
    action: oneOf('focusWindow', 'focusElement', 'invoke', 'setValue', 'select', 'toggle', 'expand', 'collapse', 'click', 'type', 'key', 'scroll', 'drag'),
    elementId: optional(text), text: optional(text), key: optional(text), coordinateSpace: optional(oneOf('image', 'screen')),
    x: optional(number), y: optional(number), toX: optional(number), toY: optional(number), button: optional(oneOf('left', 'middle', 'right')),
    clickCount: optional(number), scrollX: optional(number), scrollY: optional(number), durationMs: optional(number) },
  'browser.state': {}, 'browser.layout': { x: number, y: number, width: number, height: number, visible: boolean },
  'browser.profile.create': { name: text }, 'browser.profile.rename': { id: text, name: text },
  'browser.newTab': { profileId: optional(text), url: optional(text) },
  'browser.open': { url: text, tabId: optional(text), profileId: optional(text) }, 'browser.openFile': file,
  'browser.control': { action: oneOf('navigate', 'back', 'forward', 'reload', 'stop', 'devtools'), tabId: optional(text), url: optional(text) },
  'browser.select': tab, 'browser.takeover': tab, 'browser.allowAutomation': tab, 'browser.closeTab': tab,
};

/** 这里只检查传输形态；账号、版本冲突、坐标归属等业务判断继续由相应服务负责。 */
export function validateRpcParams(method: string, params: unknown): void {
  if (!object.accepts(params)) throw new Error('RPC 参数必须是对象。');
  const fields = Object.prototype.hasOwnProperty.call(checks, method) ? checks[method as RpcMethod] : undefined;
  if (!fields) return;
  for (const [name, check] of Object.entries(fields) as Array<[string, Check]>) {
    const value = (params as Record<string, unknown>)[name];
    if (value === undefined && check.optional) continue;
    if (!check.accepts(value)) throw new Error(`RPC ${method} 参数 ${name} 的类型不正确。`);
  }
}
