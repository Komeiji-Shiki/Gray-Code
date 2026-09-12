import { AsyncLocalStorage } from 'node:async_hooks';
import type { AutomationRecord, AutomationUsage, ModelInput, PlatformMessage, RunRecord } from '@graycode/contracts';
import { estimateModelInputTokens, modelUsage } from '../model/usage';

export class AutomationModelMeter {
  private readonly scope = new AsyncLocalStorage<string>();
  constructor(private readonly host: {
    read(id: string): Promise<AutomationRecord | null>;
    add(id: string, usage: AutomationUsage): Promise<void>;
    budgetReached(id: string): Promise<void>;
  }) {}
  currentId() { return this.scope.getStore(); }
  run(run: RunRecord, execute: () => Promise<void>) {
    return run.automationId ? this.scope.run(run.automationId, execute) : execute();
  }
  async generate(input: ModelInput, generate: () => Promise<PlatformMessage>): Promise<PlatformMessage> {
    const id = this.currentId();
    if (!id) return generate();
    const record = await this.host.read(id);
    if (!record || record.status === 'completed' || record.status === 'paused' && record.pauseReason !== 'user') throw new Error('自动任务已暂停，请在任务面板中继续。');
    if (record.tokenBudget !== undefined && record.usage.inputTokens + record.usage.outputTokens >= record.tokenBudget) {
      await this.host.budgetReached(id); throw new Error('自动任务已达到 Token 预算，未发起新的模型请求。');
    }
    let response: PlatformMessage;
    try { response = await generate(); }
    catch (error) {
      // 请求失败时不能确认上游最终消耗，只保存带标记的输入估算。
      await this.host.add(id, { inputTokens: estimateModelInputTokens(input), outputTokens: 0, cachedInputTokens: 0, requests: 1, estimatedRequests: 1, unknownRequests: 1 });
      throw error;
    }
    await this.host.add(id, modelUsage(input, response));
    return response;
  }
}
