/**
 * tokenizer 资源模块测试：格式转换纯函数 + 管理器缓存/下载/解压路径。
 *
 * 覆盖：
 * - cl100kTiktokenToJsTiktoken：官方两字段格式 → js-tiktoken 三字段格式
 * - deepseekHfToTiktoken：HF tokenizer.json → ranks/patStr/specialTokens
 *   （迷你 fixture 验证映射正确性；与官方基准的逐位一致性由开发期验证脚本确认）
 * - TokenizerResourceManager：缓存命中直接读；缺失时走下载+转换+落盘；
 *   cl100k 文本下载、deepseek zip 解压两条路径
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';

import {
    cl100kTiktokenToJsTiktoken,
    deepseekHfToTiktoken,
    CL100K_PAT_STR,
    CL100K_SPECIAL_TOKENS
} from '../../modules/tokenizer/converters';
import { TokenizerResourceManager } from '../../modules/tokenizer/TokenizerResourceManager';

// ==================== 转换纯函数 ====================

describe('cl100kTiktokenToJsTiktoken', () => {
    test('官方两字段格式转 js-tiktoken 三字段格式', () => {
        const input = 'IQ== 0\nIg== 1\nIw== 2\n';
        const output = cl100kTiktokenToJsTiktoken(input);
        expect(output).toBe('x 0 IQ==\nx 1 Ig==\nx 2 Iw==\n');
    });

    test('跳过空行与非法行', () => {
        const input = 'IQ== 0\n\nnot-a-rank\nIg== 1\n';
        const output = cl100kTiktokenToJsTiktoken(input);
        expect(output).toBe('x 0 IQ==\nx 1 Ig==\n');
    });
});

describe('deepseekHfToTiktoken', () => {
    const miniTokenizerJson = {
        model: {
            vocab: {
                '!': 0,
                'Ġ': 1,      // 空格字节映射字符
                'hello': 2,
                'Ġhello': 3
            }
        },
        added_tokens: [
            { id: 128000, content: '<｜special｜>', special: true },
            { id: 5, content: 'normal-token', special: false }
        ]
    };

    test('vocab 转换：映射字符 → 原始字节 base64，按 rank 排序', () => {
        const out = deepseekHfToTiktoken(miniTokenizerJson);
        const lines = out.bpeRanks.trim().split('\n');
        expect(lines).toHaveLength(4);
        // rank 0：'!'（字节 33）base64 = IQ==
        expect(lines[0]).toBe('x 0 IQ==');
        // rank 1：'Ġ'（空格字节 32）base64 = IA==
        expect(lines[1]).toBe('x 1 IA==');
        // rank 2：'hello' 字节 72,101,108,108,111
        expect(lines[2]).toBe('x 2 aGVsbG8=');
        // rank 3：'Ġhello' = 空格(32) + hello 小写(104,101,108,108,111)
        expect(lines[3]).toBe('x 3 IGhlbGxv');
    });

    test('仅收录 special 标记的 added_tokens', () => {
        const out = deepseekHfToTiktoken(miniTokenizerJson);
        expect(out.specialTokens).toEqual({ '<｜special｜>': 128000 });
    });

    test('patStr 为合并后的三分支交替正则', () => {
        const out = deepseekHfToTiktoken(miniTokenizerJson);
        // 三个 Split 分支都在
        expect(out.patStr).toContain('\\p{N}{1,3}');
        expect(out.patStr).toContain('[一-龥぀-ゟ゠-ヿ]+');
        expect(out.patStr).toContain('\\p{L}');
        expect(out.patStr).toContain('\\p{P}');
    });
});

// ==================== 管理器：缓存命中 ====================

describe('TokenizerResourceManager - 缓存命中', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-cache-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('缓存文件存在且足够大时直接读取，不触发下载', async () => {
        const ranks = 'x 0 IQ==\n'.repeat(200000); // 模拟大词表（>1MB）
        fs.writeFileSync(path.join(dir, 'cl100k.ranks'), ranks, 'utf8');

        const fetchMock = jest.fn();
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            const resource = await manager.ensureResource('cl100k');
            expect(resource.bpeRanks).toBe(ranks);
            expect(resource.patStr).toBe(CL100K_PAT_STR);
            expect(resource.specialTokens).toEqual(CL100K_SPECIAL_TOKENS);
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('缓存损坏（过小）时删除并重新下载', async () => {
        fs.writeFileSync(path.join(dir, 'cl100k.ranks'), 'tiny', 'utf8');

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new TextEncoder().encode('IQ== 0\nIg== 1\n').buffer
        })) as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            const resource = await manager.ensureResource('cl100k');
            expect(resource.bpeRanks).toBe('x 0 IQ==\nx 1 Ig==\n');
            // 落盘缓存已修复
            const cached = fs.readFileSync(path.join(dir, 'cl100k.ranks'), 'utf8');
            expect(cached).toBe('x 0 IQ==\nx 1 Ig==\n');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

// ==================== 管理器：下载 + 转换 + 落盘 ====================

describe('TokenizerResourceManager - 下载转换', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-dl-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('cl100k：下载文本 → 转换 → 缓存', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new TextEncoder().encode('IQ== 0\nIg== 1\nIw== 2\n').buffer
        })) as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            const resource = await manager.ensureResource('cl100k');
            expect(resource.bpeRanks).toBe('x 0 IQ==\nx 1 Ig==\nx 2 Iw==\n');
            expect(fs.existsSync(path.join(dir, 'cl100k.ranks'))).toBe(true);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('deepseek-v3：下载 zip → 解压 tokenizer.json → 转换 → 缓存（含 meta）', async () => {
        const zip = new AdmZip();
        zip.addFile(
            'deepseek_v3_tokenizer/tokenizer.json',
            Buffer.from(JSON.stringify({
                model: { vocab: { '!': 0, 'Ġ': 1 } },
                added_tokens: [{ id: 128000, content: '<｜s｜>', special: true }]
            }), 'utf8')
        );
        const zipBuffer = zip.toBuffer();

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            arrayBuffer: async () => zipBuffer
        })) as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            const resource = await manager.ensureResource('deepseek-v3');
            expect(resource.bpeRanks.trim().split('\n')).toEqual(['x 0 IQ==', 'x 1 IA==']);
            expect(resource.specialTokens).toEqual({ '<｜s｜>': 128000 });
            expect(fs.existsSync(path.join(dir, 'deepseek-v3.ranks'))).toBe(true);
            expect(fs.existsSync(path.join(dir, 'deepseek-v3.meta.json'))).toBe(true);
            // meta 内容可解析
            const meta = JSON.parse(fs.readFileSync(path.join(dir, 'deepseek-v3.meta.json'), 'utf8'));
            expect(meta.patStr).toBe(resource.patStr);
            expect(meta.specialTokens).toEqual(resource.specialTokens);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('下载失败（HTTP 错误）抛出异常', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 404
        })) as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            await expect(manager.ensureResource('cl100k')).rejects.toThrow('HTTP 404');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('并发请求共享同一次下载', async () => {
        let callCount = 0;
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => {
            callCount += 1;
            return {
                ok: true,
                arrayBuffer: async () => new TextEncoder().encode('IQ== 0\n').buffer
            };
        }) as unknown as typeof fetch;

        try {
            const manager = new TokenizerResourceManager(dir);
            const [a, b, c] = await Promise.all([
                manager.ensureResource('cl100k'),
                manager.ensureResource('cl100k'),
                manager.ensureResource('cl100k')
            ]);
            expect(a.bpeRanks).toBe('x 0 IQ==\n');
            expect(b).toBe(a); // 同一实例（in-flight 共享）
            expect(c).toBe(a);
            expect(callCount).toBe(1);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
