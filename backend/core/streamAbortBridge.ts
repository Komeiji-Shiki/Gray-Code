/**
 * GrayCode - StreamAbortManager 依赖反转桥接（backend/core 层）
 *
 * 第六批层反转修复：backend/modules/api/chat/services/ChatFlowService 不再直接 import
 * webview/stream/StreamAbortManager 类（此前经其静态 getGlobalInstance() 读取全局实例，
 * 用于 H1 写序竞态修复的旧流退出等待），改为经本 bridge 读取。
 *
 * core 不允许反向依赖 webview，因此这里不 import StreamAbortManager 类本身：
 * 只保存一个最小 port 接口引用（结构类型，StreamAbortManager 天然满足——其
 * waitForOldStreamCompletion(conversationId, timeoutMs?) 签名与本接口一致）。
 * webview 层（StreamRequestHandler 构造时）调用 setStreamAbortManager 注册实例；
 * 测试/独立调用路径未注册时 getStreamAbortManager() 返回 undefined，
 * ChatFlowService 退化为 no-op——与改造前 getGlobalInstance() 返回 undefined
 * 的处理路径完全一致。
 */

/**
 * 后端只消费的最小等待接口（结构类型）。
 *
 * StreamAbortManager.waitForOldStreamCompletion(conversationId, timeoutMs?) 签名与此
 * 一致，因此 StreamAbortManager 实例可直接赋给本接口，无需类型断言。
 */
export interface StreamAbortManagerPort {
  /** 只等待已退休旧流退出信号，不中止当前活跃流（H1 写序竞态修复） */
  waitForOldStreamCompletion(conversationId: string, timeoutMs?: number): Promise<void>;
}

let globalAbortManager: StreamAbortManagerPort | undefined;

/**
 * 注册 webview 层创建的 abort manager 全局实例。
 *
 * 调用方：webview/stream/StreamRequestHandler 构造函数（实例创建后立即注册）。
 * 传入 undefined 可清理（供测试隔离使用）。
 */
export function setStreamAbortManager(manager: StreamAbortManagerPort | undefined): void {
  globalAbortManager = manager;
}

/**
 * 读取已注册的 abort manager；未注册（测试/独立调用路径）时返回 undefined，
 * 调用方按既有语义退化为 no-op（不等待）。
 */
export function getStreamAbortManager(): StreamAbortManagerPort | undefined {
  return globalAbortManager;
}

