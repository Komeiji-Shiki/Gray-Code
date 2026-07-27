/**
 * LimCode - Diff 中断管理服务
 *
 * 对 getDiffManager().markUserInterrupt/resetUserInterrupt 做一层封装，
 * 让 ChatHandler 只依赖此服务，而不直接依赖底层工具模块。
 */

import { getDiffManager } from '../../../../tools/file/diffManager';

export class DiffInterruptService {
  /** 标记用户发起了新请求，中断之前的 diff 等待 */
  markUserInterrupt(conversationId?: string): void {
    const diffManager = getDiffManager();
    diffManager.markUserInterrupt(conversationId);
  }

  /** 重置中断标记，表示当前请求流程结束或进入下一阶段 */
  resetUserInterrupt(conversationId?: string): void {
    const diffManager = getDiffManager();
    diffManager.resetUserInterrupt(conversationId);
  }

  /**
   * 取消所有待处理的 diff（关闭编辑器并恢复文件）。
   *
   * 自身异常被捕捉：若 cancelAllPending 内部抛错，中断标记
   * 必须立即复位——否则 userInterruptFlag 永久泄漏，此后所有
   * diff 工具调用在 waitForDiffResolution 中立即返回取消。
   */
  async cancelAllPending(conversationId?: string): Promise<void> {
    const diffManager = getDiffManager();
    try {
      await diffManager.cancelAllPending(conversationId);
    } catch (err) {
      // 取消过程中出错了，但中断标记必须清零——否则后续所有
      // diff 都会被"用户中断"的假阳性拦截，扩散成全局挂死。
      diffManager.resetUserInterrupt(conversationId);
      throw err;
    }
  }
}
