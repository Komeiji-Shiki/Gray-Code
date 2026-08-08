/**
 * tokenizer 词表资源管理器：运行时联网下载词表到扩展数据目录，解压/转换后缓存使用。
 *
 * 为什么不在 vsix 里内置词表：cl100k ~1.6MB + DeepSeek V3 ~2.3MB，打进插件包体积
 * 膨胀明显；词表是纯数据且来源固定，改为首次需要时下载（下载一次后本地缓存，
 * 后续启动直接读缓存，不再联网）。
 *
 * 下载源：
 * - cl100k：OpenAI 官方 encodings CDN（cl100k_base.tiktoken）
 * - deepseek-v3：DeepSeek 官方 api-docs（deepseek_v3_tokenizer.zip）
 *
 * 转换：原始格式 → js-tiktoken/lite 可直接加载的格式（见 converters.ts）。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import AdmZip from 'adm-zip';

import {
    cl100kTiktokenToJsTiktoken,
    CL100K_PAT_STR,
    CL100K_SPECIAL_TOKENS,
    deepseekHfToTiktoken
} from './converters';

export type TokenizerResourceName = 'cl100k' | 'deepseek-v3';

export interface TokenizerResource {
    name: TokenizerResourceName;
    /** js-tiktoken 格式的 BPE ranks（每行 `x rank base64token`） */
    bpeRanks: string;
    /** 预切分正则（原始文本） */
    patStr: string;
    specialTokens: Record<string, number>;
}

interface ResourceSpec {
    name: TokenizerResourceName;
    url: string;
    /** 下载产物是否为 zip 归档（需要解压出 tokenizer.json） */
    archive?: boolean;
    /** 缓存文件（相对 tokenizer 目录） */
    ranksFile: string;
    metaFile?: string;
    /** 缓存最小字节数：小于视为损坏，触发重新下载 */
    minSize: number;
}

const RESOURCES: Record<TokenizerResourceName, ResourceSpec> = {
    cl100k: {
        name: 'cl100k',
        url: 'https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken',
        ranksFile: 'cl100k.ranks',
        minSize: 1_000_000
    },
    'deepseek-v3': {
        name: 'deepseek-v3',
        url: 'https://cdn.deepseek.com/api-docs/deepseek_v3_tokenizer.zip',
        archive: true,
        ranksFile: 'deepseek-v3.ranks',
        metaFile: 'deepseek-v3.meta.json',
        minSize: 1_000_000
    }
};

/** 下载超时（词表最大 ~2MB，120s 足够覆盖慢网络） */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 下载体积上限（字节）：词表正常 ~2MB，超过 50MB 视为异常响应，拒绝载入内存 */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export class TokenizerResourceManager {
    private inflight = new Map<TokenizerResourceName, Promise<TokenizerResource>>();
    /** 已就绪资源的进程内缓存：避免每次 ensureResource 都重新读盘（cl100k 词表 ~1.6MB） */
    private readonly memoryCache = new Map<TokenizerResourceName, TokenizerResource>();

    constructor(private readonly cacheDir: string) {}

    /** 确保资源就绪：内存缓存 → 本地磁盘缓存 → 下载+转换+缓存。并发请求共享同一次下载。 */
    async ensureResource(name: TokenizerResourceName): Promise<TokenizerResource> {
        const cached = this.memoryCache.get(name);
        if (cached) return cached;
        const existing = this.inflight.get(name);
        if (existing) return existing;
        const task = this.loadOrDownload(name).then((resource) => {
            this.memoryCache.set(name, resource);
            return resource;
        }).finally(() => {
            this.inflight.delete(name);
        });
        this.inflight.set(name, task);
        return task;
    }

    private async loadOrDownload(name: TokenizerResourceName): Promise<TokenizerResource> {
        const spec = RESOURCES[name];
        const cached = await this.readCached(spec);
        if (cached) return cached;
        const resource = await this.downloadAndConvert(spec);
        await this.writeCache(spec, resource);
        return resource;
    }

    /** 读本地缓存；缺失/损坏（过小/解析失败）返回 null */
    private async readCached(spec: ResourceSpec): Promise<TokenizerResource | null> {
        try {
            const ranksPath = path.join(this.cacheDir, spec.ranksFile);
            const ranks = await fs.readFile(ranksPath, 'utf8');
            if (ranks.length < spec.minSize) {
                // 损坏：清掉旧文件，触发重新下载
                await fs.rm(ranksPath, { force: true }).catch(() => undefined);
                return null;
            }
            let patStr = CL100K_PAT_STR;
            let specialTokens = CL100K_SPECIAL_TOKENS;
            if (spec.metaFile) {
                const meta = JSON.parse(await fs.readFile(path.join(this.cacheDir, spec.metaFile), 'utf8')) as {
                    patStr?: string;
                    specialTokens?: Record<string, number>;
                };
                patStr = meta.patStr ?? patStr;
                specialTokens = meta.specialTokens ?? specialTokens;
            }
            return { name: spec.name, bpeRanks: ranks, patStr, specialTokens };
        } catch {
            return null;
        }
    }

    /** 下载原始资源并转换为 js-tiktoken 格式 */
    private async downloadAndConvert(spec: ResourceSpec): Promise<TokenizerResource> {
        const response = await fetch(spec.url, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        });
        if (!response.ok) {
            throw new Error(`Tokenizer download failed: ${spec.url} (HTTP ${response.status})`);
        }
        // 下载大小上限：Content-Length 已知时先拒绝；缺失时以实际大小兜底
        const contentLength = Number(response.headers?.get('Content-Length') ?? 0);
        if (contentLength > MAX_DOWNLOAD_BYTES) {
            throw new Error(`Tokenizer download too large: ${contentLength} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
        }
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > MAX_DOWNLOAD_BYTES) {
            throw new Error(`Tokenizer download too large: ${buf.length} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
        }

        if (spec.archive) {
            // DeepSeek：zip → tokenizer.json → 转换
            const zip = new AdmZip(buf);
            const entry = zip.getEntry('deepseek_v3_tokenizer/tokenizer.json')
                ?? zip.getEntries().find(e => e.entryName.endsWith('tokenizer.json'));
            if (!entry) {
                throw new Error('tokenizer.json not found in downloaded archive');
            }
            const tokenizerJson = JSON.parse(entry.getData().toString('utf8'));
            const converted = deepseekHfToTiktoken(tokenizerJson);
            return {
                name: spec.name,
                bpeRanks: converted.bpeRanks,
                patStr: converted.patStr,
                specialTokens: converted.specialTokens
            };
        }

        // cl100k：官方 .tiktoken 文本（每行 base64 rank）→ js-tiktoken 格式
        return {
            name: spec.name,
            bpeRanks: cl100kTiktokenToJsTiktoken(buf.toString('utf8')),
            patStr: CL100K_PAT_STR,
            specialTokens: CL100K_SPECIAL_TOKENS
        };
    }

    /** 转换结果落盘缓存（下次启动直接读，不重新下载） */
    private async writeCache(spec: ResourceSpec, resource: TokenizerResource): Promise<void> {
        await fs.mkdir(this.cacheDir, { recursive: true });
        await fs.writeFile(path.join(this.cacheDir, spec.ranksFile), resource.bpeRanks, 'utf8');
        if (spec.metaFile) {
            await fs.writeFile(
                path.join(this.cacheDir, spec.metaFile),
                JSON.stringify({ patStr: resource.patStr, specialTokens: resource.specialTokens }),
                'utf8'
            );
        }
    }
}
