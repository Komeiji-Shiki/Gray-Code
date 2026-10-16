import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import type { ImageTokenEstimate } from '../../modules/api/chat/services/imageTokenEstimator';

const estimator = buildSync({
    entryPoints: [path.resolve(__dirname, '../../modules/api/chat/services/imageTokenEstimator.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
}).outputFiles[0].text;

async function estimateInWorker(bytes: Buffer): Promise<ImageTokenEstimate> {
    // 长度字段损坏曾让解析器无限循环；回归失败也只能消耗此线程的有界资源。
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        ${estimator}
        parentPort.postMessage(module.exports.estimateImageTokens({
            mimeType: 'image/png', data: workerData,
        }, { model: 'gpt-4o' }));
    `, {
        eval: true,
        workerData: bytes.toString('base64'),
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise<ImageTokenEstimate>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('图片尺寸解析未在两秒内结束。')), 2000);
            worker.once('message', resolve);
            worker.once('error', reject);
        });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
}

test('零长度 ICNS 条目不会挂住图片 token 估算', async () => {
    const image = Buffer.alloc(16);
    image.write('icns', 0, 'ascii');
    image.writeUInt32BE(image.length, 4);
    image.write('icp4', 8, 'ascii');
    image.writeUInt32BE(0, 12);

    await expect(estimateInWorker(image)).resolves.toEqual({
        tokens: 1600,
        source: 'generic-image-baseline',
        rule: 'unknown-image-dimensions',
    });
});

test('有效 PNG 继续按模型图片规则估算', async () => {
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+X1cAAAAASUVORK5CYII=', 'base64');
    const result = await estimateInWorker(image);
    expect(result.source).toBe('model-image-rule');
    expect(result.tokens).toBeGreaterThan(0);
});
