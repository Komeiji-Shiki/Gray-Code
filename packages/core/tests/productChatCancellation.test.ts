import { PlatformApplication } from '../../../apps/server/src/application';
import { PlatformPromptService } from '../../../apps/server/src/prompt/service';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('独立桌面输入准备和运行释放的取消边界', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication;
  let generate: jest.Mock; let conversationId: string;
  const owner = { actorId: 'owner', clientId: 'cancel-window' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    generate = jest.fn(async () => ({ role: 'model', parts: [{ text: '完成' }] }));
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate } });
    conversationId = (await app.createConversation('owner', '取消竞态夹具')).id;
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });
  const data = (id: string, streamId: string) => ({ conversationId: id, streamId, configId: 'fixture', message: '开始' });

  test('提示词尚未准备完时停止等待真实释放，取消不生成任务或用户历史', async () => {
    const entered = deferred(), release = deferred(), aborted = deferred(), authorization = deferred(), releaseAuthorization = deferred();
    const prepare = PlatformPromptService.prototype.prepare;
    jest.spyOn(PlatformPromptService.prototype, 'prepare').mockImplementationOnce(async function(this: PlatformPromptService, input) {
      entered.resolve(); await release.promise; return prepare.call(this, input);
    });
    const begin = app.runtime.start.bind(app.runtime);
    jest.spyOn(app.runtime, 'start').mockImplementation((...args) => {
      args[2]?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true }); return begin(...args);
    });
    const started = app.productUi.chat.start(owner, data(conversationId, 'prepare'), await app.product.draft());
    const rejected = expect(started).rejects.toMatchObject({ code: 'CANCELLED_ERROR' });
    let returned = false; let stopping: Promise<unknown> | undefined;
    try {
      await entered.promise;
      expect(app.productUi.chat.hasPendingStarts()).toBe(true);
      expect(await app.storage.listRuns({ conversationId, activeOnly: true })).toEqual([]);
      expect(await app.productUi.chat.awaitIdle(conversationId, 20)).toEqual({ idle: false });
      const conversation = app.conversation.bind(app);
      jest.spyOn(app, 'conversation').mockImplementationOnce(async (...args) => {
        authorization.resolve(); await releaseAuthorization.promise; return conversation(...args);
      });
      stopping = app.productUi.chat.cancel(owner, conversationId).then(value => { returned = true; return value; });
      await authorization.promise;
      await aborted.promise; expect(returned).toBe(false);
      releaseAuthorization.resolve();
      release.resolve(); expect(await stopping).toEqual({ success: true }); await rejected;
      expect(app.productUi.chat.hasPendingStarts()).toBe(false);
      expect((await app.storage.readFullHistory(conversationId)).messages).toEqual([]);
      expect(await app.storage.listRuns({ conversationId })).toEqual([]);
      expect(generate).not.toHaveBeenCalled();
    } finally { releaseAuthorization.resolve(); release.resolve(); await started.catch(() => {}); await stopping; }
  });

  test('交互队列中的输入被停止后不会在前序设置请求完成时迟到启动', async () => {
    const entered = deferred(), release = deferred();
    await app.productUi.call(owner, 'getSettings');
    const draft = app.product.draft.bind(app.product);
    jest.spyOn(app.product, 'draft').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return draft(); });
    const settings = app.productUi.call(owner, 'ui.settings.begin'); await entered.promise;
    const started = app.productUi.call(owner, 'chatStream', data(conversationId, 'queued'));
    const rejected = expect(started).rejects.toMatchObject({ code: 'CANCELLED_ERROR' });
    try {
      expect(app.productUi.chat.hasPendingStarts(conversationId)).toBe(true);
      expect(await app.productUi.chat.cancel(owner, conversationId, 20)).toEqual({ success: false, code: 'RUN_CANCEL_TIMEOUT' });
      release.resolve(); await settings; await rejected;
      expect(await app.productUi.chat.cancel(owner, conversationId, 200)).toEqual({ success: true });
      expect((await app.storage.readFullHistory(conversationId)).messages).toEqual([]);
      expect(generate).not.toHaveBeenCalled();
    } finally { release.resolve(); await settings; await started.catch(() => {}); }
  });

  test('提交已落库而启动尚未返回时停止，保留已受理输入且不启动模型', async () => {
    const committed = deferred(), release = deferred(); const commit = app.storage.commitConversation.bind(app.storage);
    jest.spyOn(app.storage, 'commitConversation').mockImplementationOnce(async value => {
      const result = await commit(value); committed.resolve(); await release.promise; return result;
    });
    const started = app.productUi.chat.start(owner, data(conversationId, 'committing'), await app.product.draft()) as Promise<{ runId: string }>;
    try {
      await committed.promise;
      expect(await app.productUi.chat.cancel(owner, conversationId, 20)).toEqual({ success: false, code: 'RUN_CANCEL_TIMEOUT' });
      release.resolve(); const run = await started;
      expect(await app.productUi.chat.cancel(owner, conversationId, 200)).toEqual({ success: true });
      expect((await app.storage.getRun(run.runId))?.status).toBe('cancelled');
      expect((await app.storage.readFullHistory(conversationId)).messages).toEqual([
        expect.objectContaining({ role: 'user', runId: run.runId, parts: [{ text: '开始' }] }),
      ]);
      expect(generate).not.toHaveBeenCalled();
    } finally { release.resolve(); await started; }
  });

  test('终态已经落库但运行清理仍被占用时停止超时返回失败，释放后才能报告成功', async () => {
    const entered = deferred(), saved = deferred(), release = deferred();
    generate.mockImplementationOnce(async input => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        input.signal.throwIfAborted(); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
      throw new Error('取消后不应继续生成');
    });
    const append = app.storage.appendRunEvent.bind(app.storage);
    jest.spyOn(app.storage, 'appendRunEvent').mockImplementation(async value => {
      const result = await append(value);
      if (value.type === 'run.cancelled') { saved.resolve(); await release.promise; }
      return result;
    });
    const run = await app.productUi.chat.start(owner, data(conversationId, 'cleanup'), await app.product.draft()) as { runId: string };
    await entered.promise;
    try {
      const stopping = app.productUi.chat.cancel(owner, conversationId, 30); await saved.promise;
      expect((await app.storage.getRun(run.runId))?.status).toBe('cancelled');
      expect(app.runtime.activeRunIds(conversationId)).toEqual([run.runId]);
      expect(await stopping).toEqual({ success: false, code: 'RUN_CANCEL_TIMEOUT' });
      expect(await app.productUi.chat.awaitIdle(conversationId, 20)).toEqual({ idle: false });
      release.resolve();
      expect(await app.productUi.chat.cancel(owner, conversationId, 200)).toEqual({ success: true });
      expect(app.runtime.activeRunIds(conversationId)).toEqual([]);
    } finally { release.resolve(); await app.runtime.wait(run.runId); }
  });

  test('旧准备取消的存储快照等待期间进入的新回合不会被取消或纳入退出等待', async () => {
    const preparing = deferred(), releasePreparation = deferred(), listed = deferred(), releaseList = deferred();
    const modelReady = deferred(), releaseModel = deferred(); let newSignal: AbortSignal | undefined;
    const prepare = PlatformPromptService.prototype.prepare;
    jest.spyOn(PlatformPromptService.prototype, 'prepare').mockImplementationOnce(async function(this: PlatformPromptService, input) {
      preparing.resolve(); await releasePreparation.promise; return prepare.call(this, input);
    });
    generate.mockImplementationOnce(async input => {
      newSignal = input.signal; modelReady.resolve();
      await Promise.race([releaseModel.promise, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      return { role: 'model', parts: [{ text: '新回合完成' }] };
    });
    const old = app.productUi.chat.start(owner, data(conversationId, 'old-preparing'), await app.product.draft());
    const rejected = expect(old).rejects.toMatchObject({ code: 'CANCELLED_ERROR' }); await preparing.promise;
    const list = app.storage.listRuns.bind(app.storage);
    jest.spyOn(app.storage, 'listRuns').mockImplementationOnce(async options => {
      const result = await list(options); expect(result).toEqual([]); listed.resolve(); await releaseList.promise; return result;
    });
    const stopping = app.productUi.chat.cancel(owner, conversationId, 500);
    let next: { runId: string } | undefined;
    try {
      await listed.promise;
      next = await app.productUi.chat.start({ ...owner, clientId: 'new-window' }, data(conversationId, 'new-during-list'), await app.product.draft()) as { runId: string };
      await modelReady.promise; releaseList.resolve(); releasePreparation.resolve(); await rejected;
      expect(await stopping).toEqual({ success: true });
      expect(newSignal?.aborted).toBe(false);
      expect((await app.storage.getRun(next.runId))?.status).toBe('running');
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      releaseList.resolve(); releasePreparation.resolve(); releaseModel.resolve();
      await old.catch(() => {}); await stopping; if (next) await app.runtime.wait(next.runId);
    }
  });

  test('旧提交和旧准备都取消后仍等待旧任务 finally，但不等待随后进入的新回合', async () => {
    const committing = deferred(), releaseCommit = deferred(), preparing = deferred(), releasePreparation = deferred();
    const cancelled = deferred(), releaseCleanup = deferred(), modelReady = deferred(), releaseModel = deferred();
    let oldRunId: string | undefined, newSignal: AbortSignal | undefined;
    const oldAborted = deferred(); const oldSignals: AbortSignal[] = []; const begin = app.runtime.start.bind(app.runtime);
    jest.spyOn(app.runtime, 'start').mockImplementation((...args) => {
      const signal = args[2]?.signal;
      if (signal && ['desktop:old-committing', 'desktop:old-preparing-together'].includes(args[0].requestKey)) {
        oldSignals.push(signal); signal.addEventListener('abort', () => {
          if (oldSignals.length === 2 && oldSignals.every(value => value.aborted)) oldAborted.resolve();
        }, { once: true });
      }
      return begin(...args);
    });
    const commit = app.storage.commitConversation.bind(app.storage);
    jest.spyOn(app.storage, 'commitConversation').mockImplementation(async value => {
      if (value.startRun?.run.requestKey === 'desktop:old-committing') {
        oldRunId = value.startRun.run.id; committing.resolve(); await releaseCommit.promise;
      }
      return commit(value);
    });
    const prepare = PlatformPromptService.prototype.prepare;
    jest.spyOn(PlatformPromptService.prototype, 'prepare').mockImplementation(async function(this: PlatformPromptService, input) {
      if (input.request.requestKey === 'desktop:old-preparing-together') { preparing.resolve(); await releasePreparation.promise; }
      return prepare.call(this, input);
    });
    const append = app.storage.appendRunEvent.bind(app.storage);
    jest.spyOn(app.storage, 'appendRunEvent').mockImplementation(async value => {
      const result = await append(value);
      if (value.runId === oldRunId && value.type === 'run.cancelled') { cancelled.resolve(); await releaseCleanup.promise; }
      return result;
    });
    generate.mockImplementationOnce(async input => {
      newSignal = input.signal; modelReady.resolve();
      await Promise.race([releaseModel.promise, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      return { role: 'model', parts: [{ text: '新回合完成' }] };
    });
    const first = app.productUi.chat.start(owner, data(conversationId, 'old-committing'), await app.product.draft()) as Promise<{ runId: string }>;
    await committing.promise;
    const second = app.productUi.chat.start({ ...owner, clientId: 'old-second' }, data(conversationId, 'old-preparing-together'), await app.product.draft());
    const rejected = expect(second).rejects.toMatchObject({ code: 'CANCELLED_ERROR' }); await preparing.promise;
    const list = app.storage.listRuns.bind(app.storage); const snapshotted = deferred();
    jest.spyOn(app.storage, 'listRuns').mockImplementationOnce(async options => { const result = await list(options); snapshotted.resolve(); return result; });
    let returned = false;
    const stopping = app.productUi.chat.cancel(owner, conversationId, 1000).then(value => { returned = true; return value; });
    let next: { runId: string } | undefined;
    try {
      await snapshotted.promise;
      // 授权完成并中止旧准备后，提交端口才能继续写入这一条已经受理的旧任务。
      await Promise.race([oldAborted.promise, stopping.then(() => { throw new Error('旧准备尚未中止，停止已经返回'); })]);
      releaseCommit.resolve(); await first;
      await Promise.race([cancelled.promise, stopping.then(() => { throw new Error('旧提交尚未结算，停止已经返回'); })]);
      expect((await app.storage.getRun(oldRunId!))?.status).toBe('cancelled');
      next = await app.productUi.chat.start({ ...owner, clientId: 'new-after-terminal' }, data(conversationId, 'new-after-old-terminal'), await app.product.draft()) as { runId: string };
      await modelReady.promise; releasePreparation.resolve(); await rejected;
      await new Promise(resolve => setImmediate(resolve)); expect(returned).toBe(false);
      releaseCleanup.resolve(); expect(await stopping).toEqual({ success: true });
      expect(newSignal?.aborted).toBe(false); expect((await app.storage.getRun(next.runId))?.status).toBe('running');
      expect(app.runtime.activeRunIds(conversationId)).toEqual([next.runId]); expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      releaseCommit.resolve(); releasePreparation.resolve(); releaseCleanup.resolve(); releaseModel.resolve();
      await first; await second.catch(() => {}); await stopping; if (next) await app.runtime.wait(next.runId);
    }
  });

  test('异步授权查询期间才受理的新输入不属于较早的停止请求', async () => {
    const authorized = deferred(), releaseAuthorization = deferred(), modelReady = deferred(), releaseModel = deferred();
    let newSignal: AbortSignal | undefined;
    const conversation = app.conversation.bind(app);
    jest.spyOn(app, 'conversation').mockImplementationOnce(async (...args) => {
      const result = await conversation(...args); authorized.resolve(); await releaseAuthorization.promise; return result;
    });
    generate.mockImplementationOnce(async input => {
      newSignal = input.signal; modelReady.resolve();
      await Promise.race([releaseModel.promise, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      return { role: 'model', parts: [{ text: '新回合完成' }] };
    });
    const stopping = app.productUi.chat.cancel(owner, conversationId, 500); let next: { runId: string } | undefined;
    try {
      await authorized.promise;
      next = await app.productUi.chat.start({ ...owner, clientId: 'new-during-authorization' }, data(conversationId, 'new-during-authorization'), await app.product.draft()) as { runId: string };
      await modelReady.promise; releaseAuthorization.resolve();
      expect(await stopping).toEqual({ success: true });
      expect(newSignal?.aborted).toBe(false); expect((await app.storage.getRun(next.runId))?.status).toBe('running');
    } finally { releaseAuthorization.resolve(); releaseModel.resolve(); await stopping; if (next) await app.runtime.wait(next.runId); }
  });
});
