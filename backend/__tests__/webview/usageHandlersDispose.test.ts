/**
 * UsageHandlers.disposeUsageCache 清理 statsCache 的单元测试
 *
 * 验证：dispose 后结果缓存被清空，同参数再次查询会重新聚合，
 * 不再命中旧统计（对应扩展重载 / 存储路径迁移场景）。
 */

// 注意：本仓库 ts-jest 不保证 hoist jest.mock，mock 声明必须放在依赖它的 import 之前
// （与 backend/__tests__/tools/diffManager.test.ts 同约定）。
jest.mock('../../../backend/modules/conversation/usageStats', () => ({
  aggregateUsageStats: jest.fn()
}));

import { getUsageStats, disposeUsageCache } from '../../../webview/handlers/UsageHandlers';
import { aggregateUsageStats } from '../../../backend/modules/conversation/usageStats';

const mockAggregate = aggregateUsageStats as unknown as jest.Mock;

function createCtx() {
  const sendResponse = jest.fn();
  const sendError = jest.fn();
  return {
    // 不返回 conversations 目录，避免初始化目录监听
    conversationManager: {
      getConversationsDirFsPath: () => undefined,
      getUsageIndexStore: () => undefined
    },
    sendResponse,
    sendError
  } as any;
}

describe('UsageHandlers disposeUsageCache', () => {
  beforeEach(() => {
    mockAggregate.mockReset();
    mockAggregate.mockResolvedValue({ totalTokens: 123, byModel: {}, byConversation: [] });
    disposeUsageCache();
  });

  afterEach(() => {
    disposeUsageCache();
    jest.restoreAllMocks();
  });

  it('未 dispose 时结果缓存命中（同参数只聚合一次）', async () => {
    const ctx = createCtx();
    await getUsageStats({ startTime: 1000, endTime: 2000 }, 'req_a', ctx);
    await getUsageStats({ startTime: 1000, endTime: 2000 }, 'req_b', ctx);

    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(ctx.sendResponse).toHaveBeenCalledTimes(2);
    expect(ctx.sendError).not.toHaveBeenCalled();
  });

  it('dispose 后 statsCache 清空：同参数再次查询重新聚合而非命中旧缓存', async () => {
    const ctx = createCtx();

    await getUsageStats({ startTime: 1000, endTime: 2000 }, 'req_1', ctx);
    await getUsageStats({ startTime: 1000, endTime: 2000 }, 'req_2', ctx);
    expect(mockAggregate).toHaveBeenCalledTimes(1); // 第二次命中缓存

    disposeUsageCache();

    await getUsageStats({ startTime: 1000, endTime: 2000 }, 'req_3', ctx);
    expect(mockAggregate).toHaveBeenCalledTimes(2); // dispose 后缓存被清空，重新聚合
    expect(ctx.sendResponse).toHaveBeenLastCalledWith('req_3', { totalTokens: 123, byModel: {}, byConversation: [] });
    expect(ctx.sendError).not.toHaveBeenCalled();
  });
});
