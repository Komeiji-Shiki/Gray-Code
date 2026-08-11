import type * as vscode from 'vscode';
import type { RunScope } from '../../backend/core/RunController';
import { PUSH_MESSAGE_NAMES } from '../../shared/protocol';

/**
 * WebviewRuntime 边界的稳定 transport client id。
 * clientId 只描述响应要发回哪个 webview endpoint；运行语义仍由 RunScope/request data 表达。
 */
export const WEBVIEW_CLIENT_IDS = {
  mainChat: 'main-chat',
  subagentMonitor: 'subagent-monitor'
} as const;

export type KnownWebviewClientId = typeof WEBVIEW_CLIENT_IDS[keyof typeof WEBVIEW_CLIENT_IDS];
export type WebviewClientId = KnownWebviewClientId | (string & {});

export interface WebviewClientRegistration {
  clientId: WebviewClientId;
  /** 可选 RunScope 投影。registry 只保存元数据，不基于 scope/type 写分支。 */
  runScope?: RunScope;
  webviewHost?: { webview: vscode.Webview };
  /** 存活判定：已销毁的 webview postMessage 会 resolve(false) 而不抛异常，仅靠 try/catch 无法识别（M8） */
  isAlive?: () => boolean;
  postMessage(message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> | boolean;
}

/**
 * webview client registry 是路由响应的唯一权威表。
 * ChatViewProvider/SubAgentMonitorPanel 注册 endpoint，MessageRouter 只按 clientId 查表，避免并发请求串响应。
 */
export class WebviewClientRegistry {
  private readonly clients = new Map<WebviewClientId, WebviewClientRegistration>();

  register(client: WebviewClientRegistration): vscode.Disposable {
    const normalizedClientId = this.normalizeClientId(client.clientId);
    const registration: WebviewClientRegistration = {
      ...client,
      clientId: normalizedClientId
    };

    // 重复 clientId 会静默覆盖旧注册（旧 endpoint 的响应将错投新 endpoint）：覆盖前留痕
    if (this.clients.has(normalizedClientId)) {
      console.warn(`[WebviewClientRegistry] Duplicate clientId registration overwritten: ${normalizedClientId}`);
    }
    this.clients.set(normalizedClientId, registration);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.clients.get(normalizedClientId) === registration) {
          this.clients.delete(normalizedClientId);
        }
      }
    };
  }

  has(clientId: unknown): clientId is WebviewClientId {
    const normalized = this.tryNormalizeClientId(clientId);
    return !!normalized && this.clients.has(normalized);
  }

  get(clientId: unknown): WebviewClientRegistration | undefined {
    const normalized = this.tryNormalizeClientId(clientId);
    return normalized ? this.clients.get(normalized) : undefined;
  }

  getWebviewHost(clientId: unknown): { webview: vscode.Webview } | undefined {
    return this.get(clientId)?.webviewHost;
  }

  resolveClientId(requestedClientId?: unknown, fallbackClientId?: unknown): WebviewClientId | undefined {
    const requested = this.tryNormalizeClientId(requestedClientId);
    const fallback = this.tryNormalizeClientId(fallbackClientId);

    if (requested && this.clients.has(requested)) {
      return requested;
    }
    if (fallback && this.clients.has(fallback)) {
      return fallback;
    }
    if (requested) {
      return requested;
    }
    if (fallback) {
      return fallback;
    }

    return undefined;
  }

  /**
   * 向指定 client 投递消息。
   *
   * @param onDeliveryFailed 异步投递失败（webview 已销毁/拒绝）时回调：同步失败（client 不存在 /
   *        isAlive 判定不可达 / 同步抛错）由返回值 false 表达，不触发回调，避免调用方双重回退。
   */
  postMessage(clientId: unknown, message: Record<string, unknown>, onDeliveryFailed?: () => void): boolean {
    const client = this.get(clientId);
    if (!client) {
      return false;
    }

    // 路由前先做存活判定：已销毁的 webview postMessage 会 resolve(false) 而不抛异常，
    // 仅靠 try/catch 无法识别「投递失败」，会让调用方误判成功、跳过回退路径（M8）
    if (client.isAlive) {
      try {
        if (!client.isAlive()) {
          return false;
        }
      } catch (error) {
        // isAlive 异常视同不存活：继续投递只会失败，直接按不可达处理
        console.warn('[WebviewClientRegistry] isAlive check threw, treating client as dead:', error);
        return false;
      }
    }

    const routedMessage = {
      ...message,
      clientId: client.clientId
    };

    try {
      const delivery = client.postMessage(routedMessage);
      if (typeof delivery !== 'boolean') {
        void Promise.resolve(delivery).then(delivered => {
          if (delivered === false) {
            console.warn('[WebviewClientRegistry] Routed webview rejected message delivery:', client.clientId);
            onDeliveryFailed?.();
          }
        }, error => {
          console.error('[WebviewClientRegistry] Failed to post routed webview message:', error);
          onDeliveryFailed?.();
        });
        // VS Code 的异步 transport 无法同步等待；isAlive 已完成同步存活判断，
        // 异步投递失败由 onDeliveryFailed 回调通知调用方回退（M8）。
        return true;
      }
      return delivery;
    } catch (error) {
      console.error('[WebviewClientRegistry] Failed to post routed webview message:', error);
      return false;
    }
  }

  sendResponse(clientId: unknown, requestId: string, data: unknown): boolean {
    return this.postMessage(clientId, {
      type: PUSH_MESSAGE_NAMES.response,
      requestId,
      success: true,
      data
    });
  }

  sendError(clientId: unknown, requestId: string, code: string, message: string): boolean {
    return this.postMessage(clientId, {
      type: PUSH_MESSAGE_NAMES.error,
      requestId,
      success: false,
      error: { code, message }
    });
  }

  private normalizeClientId(clientId: WebviewClientId): WebviewClientId {
    const normalized = String(clientId).trim();
    if (!normalized) {
      throw new Error('webview clientId must be a non-empty string');
    }
    return normalized as WebviewClientId;
  }

  private tryNormalizeClientId(clientId: unknown): WebviewClientId | undefined {
    if (typeof clientId !== 'string') {
      return undefined;
    }
    const normalized = clientId.trim();
    return normalized ? normalized as WebviewClientId : undefined;
  }
}
