import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import type { Worker } from 'node:worker_threads';
import { TextSearchWorker } from '../../../tools/search/textSearchWorker';
import { evaluateTextSearch, presentToolMatch, type TextSearchInput } from '../../../../shared/textSearch';
import { expandReplacementTemplate } from '../../../../shared/regexReplacement';
import { TEMP_DIR_REMOVE_OPTIONS } from '../../__fixtures__/tempDirectory';

const scan = (source: string, fragments = ['a😀\na😀']): TextSearchInput =>
    ({ kind: 'scan', source, flags: 'gu', fragments, limit: 10, previewChars: 300 });

test('线程保留零宽匹配、UTF-16 位置、跨行和分页顺序，替换结果与原生一致', async () => {
    const worker = new TextSearchWorker();
    try {
        for (const input of [scan('(?=😀)'), scan('a[\\s\\S]+a'), { ...scan('a', ['aa', 'aaa']), offset: 2, limit: 2 },
            { kind: 'replace', source: '(X)|(Y)', flags: 'g', text: 'XY', replacement: '$01', limit: 1, previewChars: 1 } as const]) {
            expect(await worker.run(input)).toEqual(evaluateTextSearch(input, expandReplacementTemplate, presentToolMatch));
        }
        expect(await worker.run({ kind: 'replace', source: '(X)|(Y)', flags: 'g', text: 'XY', replacement: '$01', limit: 1, previewChars: 1 }))
            .toMatchObject({ text: 'X', count: 2, changed: 1, truncated: true });
    } finally { await worker.close(); }
});

test('实际回溯超时后终止原线程，下一个文件仍可正常计算', async () => {
    const worker = new TextSearchWorker({ timeoutMs: 30 });
    try {
        await expect(worker.run(scan('a+a+a+a+b', ['a'.repeat(24000)]))).rejects.toMatchObject({ code: 'REGEX_TIMEOUT' });
        expect(await worker.run(scan('needle', ['safe needle']))).toMatchObject({ matches: [{ index: 5, text: 'needle' }] });
    } finally { await worker.close(); }
});

test('开始回溯后取消会结束真实线程，并拒绝排队中的文件', async () => {
    const controller = new AbortController(), worker = new TextSearchWorker({ signal: controller.signal });
    const failure = new Error('fixture cancelled');
    try {
        const pending = expect(worker.run(scan('a+a+a+a+b', ['a'.repeat(24000)]))).rejects.toBe(failure);
        await Promise.resolve();
        const owned = (worker as any).worker as Worker;
        expect((await once(owned, 'message'))[0]).toEqual({ started: true });
        const queued = expect(worker.run(scan('needle'))).rejects.toBe(failure);
        controller.abort(failure);
        await worker.close(); await pending; await queued;
        expect(owned.threadId).toBe(-1);
    } finally { await worker.close(); }
});

test('扩展的 keepNames 构建后，线程入口及片段格式化仍可独立运行', async () => {
    const root = path.resolve('.tmp'); await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'regex-worker-bundle-'));
    try {
        const output = path.join(directory, 'worker.cjs');
        await build({ entryPoints: ['backend/tools/search/textSearchWorker.ts'], outfile: output,
            bundle: true, platform: 'node', format: 'cjs', target: 'node20', keepNames: true });
        const source = "const { TextSearchWorker } = require(process.argv[1]); (async () => { const worker = new TextSearchWorker(); try { console.log(JSON.stringify(await worker.run(JSON.parse(process.argv[2])))); } finally { await worker.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });";
        const input: TextSearchInput = { kind: 'fileSearch', source: 'hit', flags: 'gm', fragments: ['hit first', 'hit second'],
            path: 'test.txt', offset: 1, limit: 1, previewChars: 50, linePreviewChars: 50, contextBefore: 0, contextAfter: 0, remainingChars: 500 };
        const { stdout } = await promisify(execFile)(process.execPath, ['-e', source, output, JSON.stringify(input)], { windowsHide: true, timeout: 5000 });
        expect(JSON.parse(stdout)).toMatchObject({ skipped: 1, seen: 2, matches: [{ fragment: 1, index: 0, text: 'hit', context: '2: hit second' }] });
    } finally {
        if (path.dirname(directory) !== root || !path.basename(directory).startsWith('regex-worker-bundle-')) throw new Error('验证目录不匹配');
        await rm(directory, TEMP_DIR_REMOVE_OPTIONS);
    }
});
