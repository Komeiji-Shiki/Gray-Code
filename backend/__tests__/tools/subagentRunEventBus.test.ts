/**
 * SubAgentRunEventBus 单元测试
 *
 * 覆盖：manifest 预览截断、事件 journal 有界、三个 transcript 写入口的持久化一致性、
 * 持久化写入合并，以及内存快照淘汰只发生在「已终态且可从元数据恢复」的 run 上。
 */

import { SubAgentRunEventBus, SUBAGENT_RUNS_METADATA_KEY } from '../../tools/subagents/runEventBus';
import type { SubAgentRunConversationStore } from '../../tools/subagents/runEventBus';
import type { Content } from '../../modules/conversation/types';

/** 让持久化队列（微任务链）排空 */
const flushPersistQueue = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function createStore() {
    const metadata = new Map<string, unknown>();
    const writes: number[] = [];
    const store: SubAgentRunConversationStore = {
        async getCustomMetadata(conversationId: string, key: string) {
            return metadata.get(`${conversationId}:${key}`);
        },
        async setCustomMetadata(conversationId: string, key: string, value: unknown) {
            writes.push(Date.now());
            metadata.set(`${conversationId}:${key}`, value);
        }
    };
    return {
        store,
        writes,
        read(conversationId: string) {
            return metadata.get(`${conversationId}:${SUBAGENT_RUNS_METADATA_KEY}`) as
                Record<string, { contents: Content[]; status: string; contentRevision?: number }> | undefined;
        }
    };
}

function textContent(role: Content['role'], text: string): Content {
    return { role, parts: [{ text }] } as Content;
}

describe('SubAgentRunEventBus - manifest 预览', () => {
    it('预览按上限截断，且超长单条消息不会被完整拼接', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_preview', 'Agent');
        bus.appendContent('run_preview', textContent('model', 'x'.repeat(10000)));

        const manifest = bus.getManifest('run_preview');
        expect(manifest).toBeDefined();
        // 160 字上限 + 省略号
        expect(manifest!.preview!.length).toBeLessThanOrEqual(161);
        expect(manifest!.preview!.endsWith('…')).toBe(true);
    });

    it('多个 part 拼接后仍按上限截断', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_preview_parts', 'Agent');
        bus.appendContent('run_preview_parts', {
            role: 'model',
            parts: [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(100) }, { text: 'c'.repeat(100) }]
        } as Content);

        const preview = bus.getManifest('run_preview_parts')!.preview!;
        expect(preview.length).toBeLessThanOrEqual(161);
        expect(preview.startsWith('a')).toBe(true);
    });

    it('没有可预览文本时返回 undefined', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_preview_empty', 'Agent');
        bus.appendContent('run_preview_empty', { role: 'model', parts: [] } as unknown as Content);
        expect(bus.getManifest('run_preview_empty')!.preview).toBeUndefined();
    });

    it('functionCall / functionResponse 也能生成预览', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_preview_tool', 'Agent');
        bus.appendContent('run_preview_tool', {
            role: 'model',
            parts: [{ functionCall: { name: 'read_file', args: {} } }]
        } as unknown as Content);
        expect(bus.getManifest('run_preview_tool')!.preview).toContain('read_file');
    });
});

describe('SubAgentRunEventBus - 事件 journal 有界', () => {
    it('事件数量超过上限后丢弃最旧事件', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_events', 'Agent');

        for (let i = 0; i < 700; i++) {
            bus.emit({ runId: 'run_events', type: 'tool_started', payload: { toolName: `t${i}` } } as any);
        }

        const snapshot = bus.getSnapshot('run_events')!;
        expect(snapshot.events.length).toBeLessThanOrEqual(500);
        // 保留的是最近的事件，最旧的已被丢弃
        const last = snapshot.events[snapshot.events.length - 1];
        expect((last.payload as any).toolName).toBe('t699');
    });

    it('llm_delta 不进入持久事件 journal', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_delta', 'Agent');
        const before = bus.getSnapshot('run_delta')!.events.length;

        for (let i = 0; i < 50; i++) {
            bus.emit({ runId: 'run_delta', type: 'llm_delta', payload: { delta: [] } } as any);
        }

        expect(bus.getSnapshot('run_delta')!.events.length).toBe(before);
    });
});

describe('SubAgentRunEventBus - 持久化', () => {
    it('updateLastModelContent 也会落盘（与 append/replace 一致）', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, read } = createStore();
        bus.createRun('run_persist', 'Agent', undefined, {
            conversationId: 'conv_1',
            conversationStore: store,
            initialContents: [textContent('user', 'hello')]
        });
        await flushPersistQueue();

        bus.updateLastModelContent('run_persist', textContent('model', 'final answer'));
        await flushPersistQueue();
        await flushPersistQueue();

        const persisted = read('conv_1')!['run_persist'];
        expect(persisted).toBeDefined();
        const lastPart = persisted.contents[persisted.contents.length - 1];
        expect(lastPart.parts?.[0]?.text).toBe('final answer');
    });

    it('持久化写入的 contentRevision 与内存快照一致', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, read } = createStore();
        bus.createRun('run_rev', 'Agent', undefined, {
            conversationId: 'conv_rev',
            conversationStore: store,
            initialContents: []
        });

        bus.appendContent('run_rev', textContent('user', 'a'));
        bus.updateLastModelContent('run_rev', textContent('model', 'b'));
        await flushPersistQueue();
        await flushPersistQueue();
        await flushPersistQueue();

        const persisted = read('conv_rev')!['run_rev'];
        expect(persisted.contentRevision).toBe(bus.getSnapshot('run_rev')!.contentRevision);
    });

    it('连续写入被合并，不会每次变更都触发一次落盘', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, writes } = createStore();
        bus.createRun('run_coalesce', 'Agent', undefined, {
            conversationId: 'conv_2',
            conversationStore: store,
            initialContents: []
        });

        // 同一个 tick 内产生大量 transcript 变更
        for (let i = 0; i < 30; i++) {
            bus.appendContent('run_coalesce', textContent('user', `m${i}`));
        }
        await flushPersistQueue();
        await flushPersistQueue();

        // 若不合并，30 次变更会排 30 次完整读写；合并后应该远小于该数量
        expect(writes.length).toBeLessThan(10);
    });

    it('合并不会丢内容：最终落盘包含全部变更', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, read } = createStore();
        bus.createRun('run_coalesce_2', 'Agent', undefined, {
            conversationId: 'conv_3',
            conversationStore: store,
            initialContents: []
        });

        for (let i = 0; i < 30; i++) {
            bus.appendContent('run_coalesce_2', textContent('user', `m${i}`));
        }
        await flushPersistQueue();
        await flushPersistQueue();
        await flushPersistQueue();

        const persisted = read('conv_3')!['run_coalesce_2'];
        expect(persisted.contents.length).toBe(30);
        expect(persisted.contents[29].parts?.[0]?.text).toBe('m29');
    });
});

describe('SubAgentRunEventBus - 事件载荷瘦身', () => {
    it('content_snapshot 只携带计数，不再把整份 contents 塞进事件', () => {
        const bus = new SubAgentRunEventBus();
        const events: Array<{ type: string; payload?: any }> = [];
        bus.subscribe(event => events.push({ type: event.type, payload: event.payload }));

        bus.createRun('run_payload', 'Agent');
        bus.appendContent('run_payload', textContent('user', 'hello'));
        bus.updateLastModelContent('run_payload', textContent('model', 'answer'));
        bus.replaceContents('run_payload', [textContent('user', 'rewritten')]);

        const snapshots = events.filter(event => event.type === 'content_snapshot');
        expect(snapshots.length).toBe(3);
        for (const event of snapshots) {
            expect(event.payload).toEqual({ contentCount: expect.any(Number) });
            expect(event.payload.contents).toBeUndefined();
        }
    });

    it('journal 里的历史事件不会长期引用被替换掉的 contents 数组', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('run_journal_ref', 'Agent');
        bus.appendContent('run_journal_ref', textContent('user', 'first'));
        bus.replaceContents('run_journal_ref', [textContent('user', 'second')]);

        const journal = bus.getSnapshot('run_journal_ref')!.events;
        const retained = journal.filter(event => (event.payload as any)?.contents);
        expect(retained.length).toBe(0);
    });
});

describe('SubAgentRunEventBus - 落盘节流', () => {
    it('节流窗口内的连续内容变更只发起一次落盘', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, writes } = createStore();
        bus.createRun('run_throttle', 'Agent', undefined, {
            conversationId: 'conv_throttle',
            conversationStore: store,
            initialContents: []
        });
        await flushPersistQueue();
        const afterCreate = writes.length;

        for (let i = 0; i < 20; i++) {
            bus.appendContent('run_throttle', textContent('user', `m${i}`));
            // 跨越多个 tick，验证节流依据的是时间窗口而不是同步批次
            await flushPersistQueue();
        }

        expect(writes.length - afterCreate).toBeLessThanOrEqual(1);
    });

    it('终态事件跳过节流窗口立即落盘，且写入的是最新全量内容', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, read } = createStore();
        bus.createRun('run_terminal_persist', 'Agent', undefined, {
            conversationId: 'conv_terminal',
            conversationStore: store,
            initialContents: []
        });
        await flushPersistQueue();

        for (let i = 0; i < 5; i++) {
            bus.appendContent('run_terminal_persist', textContent('user', `m${i}`));
            await flushPersistQueue();
        }

        bus.emit({ runId: 'run_terminal_persist', type: 'run_completed' } as any);
        await flushPersistQueue();
        await flushPersistQueue();

        const persisted = read('conv_terminal')!['run_terminal_persist'];
        expect(persisted.status).toBe('completed');
        expect(persisted.contents.length).toBe(5);
        expect(persisted.contents[4].parts?.[0]?.text).toBe('m4');
    });
});

describe('SubAgentRunEventBus - 快照淘汰', () => {
    /** 创建一个已终态且已绑定持久化存储的 run */
    function createTerminalRun(bus: SubAgentRunEventBus, runId: string, store: SubAgentRunConversationStore) {
        bus.createRun(runId, 'Agent', undefined, {
            conversationId: 'conv_evict',
            conversationStore: store,
            initialContents: []
        });
        bus.emit({ runId, type: 'run_completed' } as any);
    }

    it('超过上限时淘汰最旧的已终态 run', async () => {
        const bus = new SubAgentRunEventBus();
        const { store } = createStore();

        for (let i = 0; i < 260; i++) {
            createTerminalRun(bus, `run_evict_${i}`, store);
        }
        // 淘汰会跳过仍有未落盘写入的 run，等待队列排空后再触发一次
        await flushPersistQueue();
        await flushPersistQueue();
        createTerminalRun(bus, 'run_evict_last', store);
        await flushPersistQueue();

        expect(bus.getSnapshots().length).toBeLessThanOrEqual(260);
        // 最新的 run 一定还在
        expect(bus.getSnapshot('run_evict_last')).toBeDefined();
    });

    it('运行中的 run 永不被淘汰', async () => {
        const bus = new SubAgentRunEventBus();
        const { store } = createStore();

        bus.createRun('run_alive', 'Agent', undefined, {
            conversationId: 'conv_evict',
            conversationStore: store,
            initialContents: []
        });
        for (let i = 0; i < 300; i++) {
            createTerminalRun(bus, `run_bulk_${i}`, store);
        }
        await flushPersistQueue();
        await flushPersistQueue();
        createTerminalRun(bus, 'run_bulk_final', store);
        await flushPersistQueue();

        expect(bus.getSnapshot('run_alive')).toBeDefined();
        expect(bus.getSnapshot('run_alive')!.status).toBe('running');
    });

    it('没有持久化归属的 run 永不被淘汰（否则内容无法恢复）', async () => {
        const bus = new SubAgentRunEventBus();
        const { store } = createStore();

        // 无 conversationStore：只存在于内存
        bus.createRun('run_memory_only', 'Agent');
        bus.emit({ runId: 'run_memory_only', type: 'run_completed' } as any);

        for (let i = 0; i < 300; i++) {
            createTerminalRun(bus, `run_fill_${i}`, store);
        }
        await flushPersistQueue();
        await flushPersistQueue();
        createTerminalRun(bus, 'run_fill_final', store);
        await flushPersistQueue();

        expect(bus.getSnapshot('run_memory_only')).toBeDefined();
    });
});


describe('SubAgentRunEventBus - 同会话并发落盘', () => {
    /**
     * 慢存储：get 在调用时刻立即捕获盘面（等价于两个进程同时读到同一份旧文件），再延迟返回。
     * 修复前两个 run 的落盘按 runId 并行，两个读都会基于同一空盘面计算，后写者覆盖先写者。
     */
    function createSlowStore() {
        const metadata = new Map<string, unknown>();
        const store: SubAgentRunConversationStore = {
            async getCustomMetadata(conversationId: string, key: string) {
                const captured = metadata.get(`${conversationId}:${key}`);
                await new Promise(resolve => setTimeout(resolve, 10));
                return captured;
            },
            async setCustomMetadata(conversationId: string, key: string, value: unknown) {
                metadata.set(`${conversationId}:${key}`, value);
            }
        };
        return { store, metadata };
    }

    it('同一会话两个 run 并发 flush 不互相覆盖（按 conversationId 串行）', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, metadata } = createSlowStore();

        bus.createRun('run_conv_a', 'Agent A', undefined, {
            conversationId: 'conv_race',
            conversationStore: store,
            initialContents: []
        });
        bus.createRun('run_conv_b', 'Agent B', undefined, {
            conversationId: 'conv_race',
            conversationStore: store,
            initialContents: []
        });

        // 同一 tick 内两个 run 同时产生内容变更并进入终态：
        // 修复前两个落盘并发「读整份 metadata → 各改一条 → 写回整份」，后写者覆盖先写者，丢失对方 run。
        bus.appendContent('run_conv_a', textContent('user', 'a1'));
        bus.appendContent('run_conv_b', textContent('user', 'b1'));
        bus.emit({ runId: 'run_conv_a', type: 'run_completed' } as any);
        bus.emit({ runId: 'run_conv_b', type: 'run_completed' } as any);

        await flushPersistQueue();
        await flushPersistQueue();
        await flushPersistQueue();
        // 等慢存储的真实读写完成
        await new Promise(resolve => setTimeout(resolve, 80));

        const persisted = metadata.get(`conv_race:${SUBAGENT_RUNS_METADATA_KEY}`) as
            Record<string, { status: string; contents: Content[] }> | undefined;
        expect(persisted).toBeDefined();
        // 两个 run 的记录都必须存在，谁也不能覆盖谁
        expect(persisted!['run_conv_a']).toBeDefined();
        expect(persisted!['run_conv_b']).toBeDefined();
        expect(persisted!['run_conv_a'].status).toBe('completed');
        expect(persisted!['run_conv_b'].status).toBe('completed');
        expect(persisted!['run_conv_a'].contents[0].parts?.[0]?.text).toBe('a1');
        expect(persisted!['run_conv_b'].contents[0].parts?.[0]?.text).toBe('b1');
    });

    it('同一会话连续多次 flush 仍保留两个 run 的完整记录', async () => {
        const bus = new SubAgentRunEventBus();
        const { store, metadata } = createSlowStore();

        bus.createRun('run_conv_c', 'Agent C', undefined, {
            conversationId: 'conv_race2',
            conversationStore: store,
            initialContents: []
        });
        bus.createRun('run_conv_d', 'Agent D', undefined, {
            conversationId: 'conv_race2',
            conversationStore: store,
            initialContents: []
        });

        // 交错写入：a 追加两轮、b 追加两轮，每轮都触发落盘
        for (let i = 0; i < 2; i++) {
            bus.appendContent('run_conv_c', textContent('user', `c${i}`));
            bus.appendContent('run_conv_d', textContent('user', `d${i}`));
            await flushPersistQueue();
        }
        await flushPersistQueue();
        await new Promise(resolve => setTimeout(resolve, 80));

        const persisted = metadata.get(`conv_race2:${SUBAGENT_RUNS_METADATA_KEY}`) as
            Record<string, { contents: Content[] }> | undefined;
        expect(persisted).toBeDefined();
        expect(persisted!['run_conv_c'].contents.length).toBe(2);
        expect(persisted!['run_conv_d'].contents.length).toBe(2);
        expect(persisted!['run_conv_c'].contents[1].parts?.[0]?.text).toBe('c1');
        expect(persisted!['run_conv_d'].contents[1].parts?.[0]?.text).toBe('d1');
    });

    it('不同会话的落盘互不阻塞（串行化只按会话隔离）', async () => {
        const bus = new SubAgentRunEventBus();
        const metadata = new Map<string, unknown>();
        let readCount = 0;
        let releaseReads: () => void = () => undefined;
        const bothReadsInFlight = new Promise<void>(resolve => { releaseReads = resolve; });
        const store: SubAgentRunConversationStore = {
            async getCustomMetadata(conversationId: string, key: string) {
                readCount++;
                if (readCount === 2) releaseReads();
                await bothReadsInFlight;
                return metadata.get(`${conversationId}:${key}`);
            },
            async setCustomMetadata(conversationId: string, key: string, value: unknown) {
                metadata.set(`${conversationId}:${key}`, value);
            }
        };

        bus.createRun('run_c1', 'Agent', undefined, { conversationId: 'conv_1', conversationStore: store, initialContents: [] });
        bus.createRun('run_c2', 'Agent', undefined, { conversationId: 'conv_2', conversationStore: store, initialContents: [] });
        bus.appendContent('run_c1', textContent('user', 'x'));
        bus.appendContent('run_c2', textContent('user', 'y'));

        // 两个会话的读请求应能同时到达；若被错误地全局串行化，这里会超时失败
        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        const serializedTimeout = new Promise((_, reject) => {
            raceTimer = setTimeout(() => reject(new Error('reads serialized across conversations')), 500);
        });
        try {
            await expect(Promise.race([bothReadsInFlight, serializedTimeout])).resolves.toBeUndefined();
        } finally {
            clearTimeout(raceTimer);
        }

        await flushPersistQueue();
        await flushPersistQueue();
        await flushPersistQueue();

        const c1 = metadata.get(`conv_1:${SUBAGENT_RUNS_METADATA_KEY}`) as Record<string, { contents: Content[] }> | undefined;
        const c2 = metadata.get(`conv_2:${SUBAGENT_RUNS_METADATA_KEY}`) as Record<string, { contents: Content[] }> | undefined;
        expect(c1?.['run_c1']).toBeDefined();
        expect(c2?.['run_c2']).toBeDefined();
    });
});


describe('SubAgentRunEventBus - 独立 transcript 存储', () => {
    function createExternalStore(initialMetadata?: unknown) {
        let metadata = initialMetadata;
        const transcripts = new Map<string, { contents: Content[]; lastSentHistory?: Content[] }>();
        const store: SubAgentRunConversationStore = {
            async getCustomMetadata() { return metadata; },
            async setCustomMetadata(_conversationId, _key, value) { metadata = value; },
            async saveSubAgentTranscript(conversationId, runId, data) {
                transcripts.set(`${conversationId}:${runId}`, JSON.parse(JSON.stringify(data)));
                return `subagents/${runId}.json`;
            },
            async loadSubAgentTranscript(conversationId, runId) {
                return transcripts.get(`${conversationId}:${runId}`) ?? null;
            }
        };
        return { store, transcripts, readMetadata: () => metadata as Record<string, any> };
    }

    it('正式新路径只在元数据保存轻量索引，完整内容写入独立 transcript', async () => {
        const bus = new SubAgentRunEventBus();
        const external = createExternalStore();
        bus.createRun('run_external', 'Agent', undefined, {
            conversationId: 'conv_external',
            conversationStore: external.store,
            initialContents: [textContent('user', '包含大内容')]
        });
        bus.updateLastSentHistory('run_external', [textContent('user', 'provider history')]);
        await bus.flushConversation('conv_external');

        const record = external.readMetadata().run_external;
        expect(record.transcriptRef).toBe('subagents/run_external.json');
        expect(record.contentCount).toBe(1);
        expect(record.contents).toBeUndefined();
        expect(record.lastSentHistory).toBeUndefined();
        expect(external.transcripts.get('conv_external:run_external')).toEqual({
            contents: [textContent('user', '包含大内容')],
            lastSentHistory: [textContent('user', 'provider history')]
        });
    });

    it('读取旧内嵌格式时迁移到独立 transcript 并清除元数据大字段', async () => {
        const legacyContents = [textContent('user', 'legacy')];
        const legacyHistory = [textContent('model', 'history')];
        const external = createExternalStore({
            legacy_run: {
                runId: 'legacy_run', agentName: 'Agent', status: 'completed', createdAt: 1, updatedAt: 2,
                contents: legacyContents, lastSentHistory: legacyHistory
            }
        });
        const bus = new SubAgentRunEventBus();
        const loaded = await bus.loadConversationSnapshots('conv_legacy', external.store);

        expect(loaded[0].contents).toEqual(legacyContents);
        expect(loaded[0].lastSentHistory).toEqual(legacyHistory);
        expect(external.readMetadata().legacy_run.contents).toBeUndefined();
        expect(external.readMetadata().legacy_run.lastSentHistory).toBeUndefined();
        expect(external.readMetadata().legacy_run.transcriptRef).toBe('subagents/legacy_run.json');
    });
});
describe('SubAgentRunEventBus - runId 分配', () => {
    it('runId 未被占用时原样返回', () => {
        const bus = new SubAgentRunEventBus();
        expect(bus.allocateRunId('subagent_run_tool_1')).toBe('subagent_run_tool_1');
    });

    it('旧 run 已终态时沿用同名（前端按 toolId 推导 runId 关联工具卡）', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('subagent_run_tool_1', 'Agent');
        bus.emit({ runId: 'subagent_run_tool_1', type: 'run_completed' } as any);

        expect(bus.allocateRunId('subagent_run_tool_1')).toBe('subagent_run_tool_1');
    });

    it('旧 run 仍活跃时改名，避免覆盖快照与共用 AbortController', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('subagent_run_tool_1', 'Agent');

        const allocated = bus.allocateRunId('subagent_run_tool_1');
        expect(allocated).toBe('subagent_run_tool_1__2');

        bus.createRun(allocated, 'Agent');
        expect(bus.getSnapshot('subagent_run_tool_1')).toBeDefined();
        expect(bus.getSnapshot(allocated)).toBeDefined();
    });

    it('连续冲突时后缀继续递增', () => {
        const bus = new SubAgentRunEventBus();
        bus.createRun('subagent_run_tool_1', 'Agent');
        bus.createRun(bus.allocateRunId('subagent_run_tool_1'), 'Agent');

        expect(bus.allocateRunId('subagent_run_tool_1')).toBe('subagent_run_tool_1__3');
    });
});
