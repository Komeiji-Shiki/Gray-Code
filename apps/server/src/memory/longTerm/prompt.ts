import { createHash } from 'node:crypto';
import type { LongMemoryHit, LongMemoryScopeState, PlatformMessage, ModelInput, VersionedRecord } from '@graycode/contracts';
import { estimateMemoryTokens, type ModelRequestContext } from '@graycode/core';
import type { PlatformLongMemory } from './service';
import { messageText, recallText, recordRef } from './content';
import { MemoryHistoryView,memoryReferences, type MemoryRecordReference } from './history';

interface MemoryTurnSnapshot {
  queryHash: string;
  policyHash: string;
  asOf: number;
  knownAt: number;
  states: LongMemoryScopeState[];
  records: Array<MemoryRecordReference & { score: number; reasons: string[]; conflicts: string[] }>;
  method: 'keyword' | 'hybrid';
  embeddingError?: string;
  /** 保存实际选中内容；召回策略与资料普通修订不改写已经发出的历史前缀。 */
  injection?: MemoryInjection;
}
interface MemoryInjection {
  text: string;
  references: MemoryRecordReference[];
  estimatedTokens: number;
  scopeIds: string[];
}
interface MemoryReplay { turnId: string; injection: MemoryInjection }
export interface PreparedMemory {
  text: string;
  turnId?: string;
  references: MemoryRecordReference[];
  estimatedTokens: number;
  method: 'keyword' | 'hybrid';
  embeddingError?: string;
  replay?: MemoryReplay[];
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const referenceKey = (reference: MemoryRecordReference) => JSON.stringify([reference.scopeId, reference.id, reference.version]);
type CaptureContext = Pick<ModelRequestContext, 'run' | 'input' | 'history'>;
interface CachedTurn { revision: number | null; snapshot: MemoryTurnSnapshot | null }

export class LongMemoryPrompt {
  readonly history:MemoryHistoryView;
  /** 每个对话最近一条回复的完整输入；下一条回复只记录相对它新增的输入。重启后首条回复记录完整列表。 */
  private readonly lastInputs=new Map<string,{messageId:string;ids:Set<string>}>();
  private readonly turnSnapshots = new Map<string, Map<string, CachedTurn>>();
  private readonly replayMessages = new WeakMap<MemoryInjection, PlatformMessage>();
  constructor(private readonly service:PlatformLongMemory){this.history=new MemoryHistoryView(service.app);}
  private async loadTurns(context: CaptureContext, actorId: string, turns: PlatformMessage[], preview: boolean): Promise<Map<string, CachedTurn>> {
    const key = JSON.stringify([actorId, context.run.conversationId]);
    let cache = this.turnSnapshots.get(key);
    if (!cache) {
      cache = new Map();
      if (!preview) {
        if (this.turnSnapshots.size >= 128) this.turnSnapshots.delete(this.turnSnapshots.keys().next().value!);
        this.turnSnapshots.set(key, cache);
      }
    }
    const ids = new Set(turns.map(turn => hash([actorId, context.run.conversationId, turn.id])));
    if (!preview) for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const missing = [...ids].filter(id => !cache!.has(id));
    const remember = (id: string, record: VersionedRecord) => cache!.set(id, {
      revision: record.revision, snapshot: record.value as MemoryTurnSnapshot | null,
    });
    // 冷启动批量恢复活跃回合；沿用运行时游标，不再次传输已经读取的历史正文。
    for (let offset = 0; offset < missing.length; offset += 256) {
      const batch = missing.slice(offset, offset + 256);
      if (batch.length === 1) {
        remember(batch[0], await this.service.app.storage.getVersionedRecord('long-memory-turns', batch[0]));
      } else {
        const state = await this.service.app.storage.readConversationState(context.run.conversationId,
          batch.map(id => ({ namespace: 'long-memory-turns', id })),
          { cursor: { runId: context.run.id, revision: context.history.history.revision } });
        for (const { id, record } of state.records) remember(id, record);
      }
    }
    // 预览和未完成的提交只修改本次副本，缓存始终对应已经提交的快照。
    return new Map([...cache].map(([id, value]) => [id, { ...value }]));
  }
  async capture(context: CaptureContext, preview = false, activeMessages = context.history.history.messages): Promise<PreparedMemory> {
    const empty: PreparedMemory = { text: '', references: [], estimatedTokens: 0, method: 'keyword' };
    const app = this.service.app;
    if (!app.product.runtimeSettings().isMemoryEnabled()) return empty;
    const actor = app.actor(context.run.actorId);
    if (!actor || actor.role === 'guest' || actor.role !== 'owner' && !actor.effects.includes('workspace_read')) return empty;
    const turns = activeMessages.filter(message => message.id && message.isUserInput && !message.userFeedback && !message.isSummary
      && !message.isSummarized && !message.memoryRedacted);
    if (!turns.length) return empty;
    const turn = context.history.history.messages.findLast(message => message.isUserInput && !message.userFeedback);
    const access = await this.service.access(context.run.actorId, {
      runId: context.run.id, conversationId: context.run.conversationId, workspaceId: context.run.workspaceId,
      ...(preview ? { capturedConversation: context.history.metadata } : {}),
    });
    if (!access.scopes.length) return empty;
    const policy = (await this.service.policies.get(access.scopes[0].actorId)).value;
    if (!policy.enabled) return empty;
    const cache = await this.loadTurns(context, access.actor.id, turns, preview);
    const scopes = new Set(access.scopes.map(scope => scope.id));
    const changes = new Set<string>();
    // 空库也提供真实范围编号，避免初次“记住约定”时猜测 scopeId 或退回工程日志。
    const scopeHint=context.input.turnContext?.companionTurn && context.input.tools.some(tool=>tool.name==='memory_remember')
      ? `本轮可以使用的长期记忆范围：${access.scopes.map(scope=>`${scope.kind==='personal'?'个人':scope.kind==='workspace'?'当前项目':scope.kind==='library'?'导入资料库':'群组'}（${scope.realm==='real'?'真实资料':'角色剧情'}）scopeId=${scope.id}`).join('；')}。保存个人偏好、经历和约定时用个人范围，保存项目知识时用项目范围。\n\n` : '';
    const render = (hits: LongMemoryHit[], hint: string): MemoryInjection => {
      const selected: LongMemoryHit[] = [];
      const heading = '与本轮相关的长期记忆如下。它们都注明了来源，只作参考；当前用户明确纠正时以用户为准。'
        + '需要更多主题或来源时，可以用 memory_topics、memory_search、memory_read 继续查阅。\n\n';
      let text = hint;
      let estimatedTokens = estimateMemoryTokens(text);
      for (const hit of hits) {
        const candidate = (selected.length ? text + '\n\n' : hint + heading) + recallText([hit]);
        const tokens = estimateMemoryTokens(candidate);
        if (tokens <= policy.recallTokens) {
          selected.push(hit);
          text = candidate;
          estimatedTokens = tokens;
        }
      }
      return { text, references: selected.map(hit => recordRef(hit.record)), estimatedTokens,
        scopeIds: hint ? access.scopes.map(scope => scope.id) : [...new Set(selected.map(hit => hit.record.scopeId))] };
    };
    // 旧记录没有正文，只按已保存的确切版本重建一次，不用今天的召回结果改写旧回合。
    const legacy = [...cache].filter(([, value]) => value.snapshot && !value.snapshot.injection);
    const references = new Map(legacy.flatMap(([, value]) => value.snapshot!.records)
      .filter(ref => scopes.has(ref.scopeId)).map(ref => [referenceKey(ref), ref]));
    const records = new Map<string, LongMemoryHit['record']>();
    for (const scope of access.scopes) {
      const refs = [...references.values()].filter(ref => ref.scopeId === scope.id);
      for (let offset = 0; offset < refs.length; offset += 256) {
        const batch = await app.storage.longMemoryRecordVersions({ scope, references: refs.slice(offset, offset + 256) });
        for (const record of batch) records.set(referenceKey(record), record);
      }
    }
    const currentId = turn?.id ? hash([access.actor.id, context.run.conversationId, turn.id]) : undefined;
    for (const [id, cached] of legacy) {
      const snapshot = cached.snapshot!;
      const hits = snapshot.records.flatMap(ref => {
        const record = records.get(referenceKey(ref));
        return record ? [{ record, score: ref.score, reasons: ref.reasons, conflicts: ref.conflicts }] : [];
      });
      cached.snapshot = { ...snapshot, injection: render(hits, id === currentId ? scopeHint : '') };
      changes.add(id);
    }
    const current = currentId ? cache.get(currentId) : undefined;
    if (current && !current.snapshot) {
      const original = messageText(turn!);
      const text = original.length > 8000 ? original.slice(0, 4000) + '\n' + original.slice(-4000) : original;
      const states = await Promise.all(access.scopes.map(scope => app.storage.longMemoryState(scope)));
      const now = Date.now();
      let snapshot: MemoryTurnSnapshot = {
        queryHash: hash(text), policyHash: hash(policy), asOf: now, knownAt: now, states, method: 'keyword', records: [],
      };
      let hits: LongMemoryHit[] = [];
      if (text.trim() && states.some(state => state.hasRecords)) {
        const query = await this.service.query(access, { text }, context.input.signal, preview);
        const result = await app.storage.longMemoryRecall(query);
        hits = result.hits;
        snapshot = { ...snapshot, asOf: query.asOf, knownAt: query.knownAt, states: result.states,
          method: result.method, embeddingError: query.embeddingError,
          records: hits.map(hit => ({ ...recordRef(hit.record), score: hit.score, reasons: hit.reasons, conflicts: hit.conflicts })) };
      }
      current.snapshot = { ...snapshot, injection: render(hits, scopeHint) };
      changes.add(currentId!);
    }
    if (!preview) for (let offset = 0; offset < changes.size; offset += 256) {
      const ids = [...changes].slice(offset, offset + 256);
      const committed = await app.storage.commitRecords(ids.map(id => ({ namespace: 'long-memory-turns', id,
        ownerId: context.run.conversationId, expectedRevision: cache.get(id)!.revision, value: cache.get(id)!.snapshot })));
      for (const record of committed) cache.get(record.id)!.revision = record.revision;
    }
    if (!preview) this.turnSnapshots.set(JSON.stringify([access.actor.id, context.run.conversationId]), cache);
    const replay = turns.flatMap(message => {
      const snapshot = cache.get(hash([access.actor.id, context.run.conversationId, message.id]))?.snapshot;
      const injection = snapshot?.injection;
      return injection && injection.scopeIds.every(id => scopes.has(id)) ? [{ injection, turnId: message.id! }] : [];
    });
    const selected = replay.find(item => item.turnId === turn?.id);
    return { ...empty, ...selected?.injection, turnId: selected?.turnId,
      method: current?.snapshot?.method ?? 'keyword', embeddingError: current?.snapshot?.embeddingError, replay };
  }
  inject(messages: PlatformMessage[], memory: PreparedMemory, input: ModelInput, original: PlatformMessage[] = [],
    filter: (messages: PlatformMessage[]) => PlatformMessage[] = messages => messages): PlatformMessage[] {
    const replay = memory.replay ?? (memory.turnId ? [{ turnId: memory.turnId, injection: { ...memory, scopeIds: [] } }] : []);
    const snapshots = new Map(replay.map(item => [item.turnId, item.injection]));
    const blocks = filter(replay.filter(item => item.injection.text).map(({ turnId, injection }) => {
      let message = this.replayMessages.get(injection);
      if (!message) {
        message = { role: 'user', id: 'long-memory:' + turnId, memoryContext: true,
          longMemoryReferences: injection.references, parts: [{ text: injection.text }] };
        this.replayMessages.set(injection, message);
      }
      return message;
    }));
    const byId = new Map(blocks.filter(message => !message.memoryRedacted).map(message => [message.id, message]));
    const result: PlatformMessage[] = [];
    let estimatedTokens = 0;
    const currentReferences: MemoryRecordReference[] = [];
    for (const message of messages) {
      if (message.memoryContext && message.id?.startsWith('long-memory:')) continue;
      // 只回放仍在模型历史中的真实回合；摘要覆盖、裁剪和已遗忘的输入不会被快照重新恢复。
      const block = message.id && !message.memoryRedacted && !message.isSummary && !message.isSummarized
        ? byId.get('long-memory:' + message.id) : undefined;
      if (block) {
        result.push(block);
        const snapshot = snapshots.get(message.id!)!;
        estimatedTokens += snapshot.estimatedTokens;
        if (message.id === memory.turnId) currentReferences.push(...snapshot.references);
      }
      result.push(message);
    }
    const originalById = new Map(original.map(message => [message.id, message]));
    const dependencies = new Map<string, MemoryRecordReference>();
    for (const message of result) for (const ref of memoryReferences(message.memoryContext ? message : originalById.get(message.id) ?? message)) {
      const key = JSON.stringify([ref.scopeId, ref.id]);
      if ((dependencies.get(key)?.version ?? 0) <= ref.version) dependencies.set(key, ref);
    }
    input.turnContext ??= {};
    input.turnContext.longMemory = { references: currentReferences, derivedReferences: [...dependencies.values()],
      estimatedTokens, method: memory.method, embeddingError: memory.embeddingError };
    return result;
  }
  /**
   * 记录回复依赖的输入。完整列表会让每条回复都携带此前全部消息 ID，长会话的历史体积和
   * 遗忘判定都按平方增长。上一条回复仍在输入中时改为增量：longMemoryInputBase 指向它，
   * longMemoryInputIds 只列出相对它新增的输入。基线自身的依赖已计入它的屏蔽判定，结果与完整列表一致。
   */
  output(message:PlatformMessage,input:ModelInput):PlatformMessage{
    const memory=input.turnContext?.longMemory as {references?:MemoryRecordReference[];derivedReferences?:MemoryRecordReference[]}|undefined;
    const ids=input.messages.filter(item=>item.id&&!item.memoryContext&&!item.memoryRedacted).map(item=>item.id!);
    const previous=this.lastInputs.get(input.conversationId);
    const dependencies=previous&&ids.includes(previous.messageId)
      ?{longMemoryInputBase:previous.messageId,longMemoryInputIds:ids.filter(id=>!previous.ids.has(id))}
      :{longMemoryInputIds:ids};
    if(message.id){
      this.lastInputs.delete(input.conversationId);
      if(this.lastInputs.size>=256)this.lastInputs.delete(this.lastInputs.keys().next().value!);
      this.lastInputs.set(input.conversationId,{messageId:message.id,ids:new Set(ids)});
    }
    return {...message,...dependencies,
      ...(memory?.derivedReferences?.length?{longMemoryReferences:memory.derivedReferences}:{})};
  }
}
