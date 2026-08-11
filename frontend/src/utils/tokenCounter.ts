/**
 * 模型 token 计数管线（运行时词表 + 自校准叠加）。
 *
 * 词表不打包进 vsix：cl100k（~1.6MB）与 DeepSeek V3（~2.3MB）由扩展端
 * TokenizerResourceManager 运行时联网下载到数据目录（首次需要时触发，下载一次
 * 本地缓存），前端通过 tokenizer.getResource 消息通道获取，用 js-tiktoken/lite
 * （BPE 引擎，~9KB）加载。下载失败/离线时回退字符类别加权估算，不阻塞业务。
 *
 * 精度阶梯（多提供商场景下 tokenizer 不是终点，需叠加校准）：
 * 1. 模型专属 tokenizer：DeepSeek 用官方 deepseek_v3_tokenizer 转换词表（与官方
 *    Python 基准逐位一致）；其余模型用 cl100k（OpenAI 系近精确，对其他模型有
 *    系统性偏差 5~20%，由校准因子修正）。
 * 2. 自校准因子（按 modelKey 持久化到 localStorage）：每轮流结束拿最终 usage 真值
 *    （candidatesTokenCount，含思考 token，与估算端计入 thought 的口径一致）对比
 *    本轮 base 估算，EMA 学习乘法因子；离群剔除（0.4~2.5）挡 usage 异常样本。
 *    同一模型的系统性偏差稳定，因子收敛后误差压到 ~3~5%。
 * 3. 回退：词表未就绪/加载失败时字符类别加权估算（ASCII/CJK/其他分系数），同样乘因子。
 *
 * 性能：同步 BPE 编码常规 chunk <1ms；超长文本分批（BATCH_SIZE 字符/片）规避
 * 大输入时合并缓存的非线性退化。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from './vscode'

/** 分批阈值：超过后按片计数，规避 tokenizer 合并缓存的非线性退化 */
const BATCH_SIZE = 2000

/** 字符类别加权基线系数（回退估算用，tokens ≈ chars / 系数） */
const FALLBACK_ASCII = 3.6
const FALLBACK_CJK = 1.5
const FALLBACK_OTHER = 2.5

/** 校准门槛：base 估算或真实 token 太少时噪声大，跳过 */
const CALIBRATION_MIN_BASE = 50
const CALIBRATION_MIN_REAL = 1
/** 离群剔除：超出该范围的 raw 比率视为 usage 异常样本（字段缺失/多轮混合/截断等） */
const CALIBRATION_CLAMP_MIN = 0.4
const CALIBRATION_CLAMP_MAX = 2.5
/** EMA 更新权重：新样本 0.3 / 历史 0.7 */
const CALIBRATION_EMA_NEW = 0.3
const CALIBRATION_EMA_OLD = 0.7
const CALIBRATION_KEY_PREFIX = 'graycode:tpsCal:'

type TokenizerKind = 'gpt' | 'deepseek'

/** 扩展端下发的词表资源（与 backend/modules/tokenizer 的 TokenizerResource 对应） */
interface TokenizerResource {
  name: string
  bpeRanks: string
  patStr: string
  specialTokens: Record<string, number>
}

/** 已就绪的计数函数（词表加载完成后设置） */
const tokenizerCounters = new Map<TokenizerKind, (text: string) => number>()
/** 加载中 Promise（并发去重） */
const tokenizerLoadPromises = new Map<TokenizerKind, Promise<void>>()

/** 按模型名选择专属 tokenizer：DeepSeek 用官方词表，其余用 cl100k（校准因子修正偏差） */
function pickTokenizerKind(modelKey: string): TokenizerKind {
  return modelKey.toLowerCase().includes('deepseek') ? 'deepseek' : 'gpt'
}

/** 字符类别加权基线估算（词表不可用时的回退；CJK 范围参考 tiktoken 常见口径） */
function baseEstimateByCharClass(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 128) {
      ascii++
    } else if (
      (code >= 0x3000 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++
    } else {
      other++
    }
  }
  return ascii / FALLBACK_ASCII + cjk / FALLBACK_CJK + other / FALLBACK_OTHER
}

/** 从扩展端拉取词表并构造计数函数（下载可能耗时，允许长超时） */
async function loadTokenizer(kind: TokenizerKind): Promise<void> {
  const name = kind === 'deepseek' ? 'deepseek-v3' : 'cl100k'
  const resource = await sendToExtension<TokenizerResource>(
    MESSAGE_NAMES['tokenizer.getResource'],
    { name },
    { timeoutMs: 120_000 }
  )
  const { Tiktoken } = await import('js-tiktoken/lite')
  const enc = new Tiktoken({
    bpe_ranks: resource.bpeRanks,
    pat_str: resource.patStr,
    special_tokens: resource.specialTokens
  })
  tokenizerCounters.set(kind, (text: string) => enc.encode(text).length)
}

function ensureLoaded(kind: TokenizerKind): void {
  if (tokenizerCounters.has(kind)) return
  if (tokenizerLoadPromises.has(kind)) return
  const task = loadTokenizer(kind)
    .catch(() => {
      // 下载/加载失败（离线、源不可达）：保持回退估算；下次会话再试
    })
    .finally(() => {
      tokenizerLoadPromises.delete(kind)
    })
  tokenizerLoadPromises.set(kind, task)
}

function countWith(fn: ((text: string) => number) | null, text: string): number | null {
  if (!fn) return null
  if (text.length <= BATCH_SIZE) return fn(text)
  let total = 0
  // 误差说明（不改算法）：分片计数会丢失跨片边界的 token 合并——BPE 合并缓存按片重置，
  // 本可合并为一个 token 的跨片字符序列会被计为多个，因此结果系统性略偏高（高估方向，
  // 常规文本误差通常 <1%）；这是分批规避非线性退化的既定代价，仅用于估算/展示，不做修正。
  for (let i = 0; i < text.length; i += BATCH_SIZE) {
    total += fn(text.slice(i, i + BATCH_SIZE))
  }
  return total
}

/**
 * 统计文本的 base token 数（同步，未经校准因子修正）。
 * 按 modelKey 选择专属 tokenizer；未就绪/失败时回退字符类别加权估算。
 */
export function countBaseTokens(text: string, modelKey: string): number {
  if (!text) return 0
  const kind = pickTokenizerKind(modelKey)
  const fn = tokenizerCounters.get(kind) ?? null
  const counted = countWith(fn, text)
  if (counted !== null && counted > 0) return counted
  return Math.max(1, Math.ceil(baseEstimateByCharClass(text)))
}

/** 触发 modelKey 对应 tokenizer 的加载（幂等，通过消息通道向扩展端获取词表） */
export function ensureTokenCounterLoaded(modelKey: string): void {
  ensureLoaded(pickTokenizerKind(modelKey))
}

/** 查询 modelKey 对应 tokenizer 是否已加载就绪（false = 当前走字符加权估算） */
export function isTokenizerReady(modelKey: string): boolean {
  return tokenizerCounters.has(pickTokenizerKind(modelKey))
}

/** 读取 modelKey 的校准因子（未学习时 1） */
export function getCalibrationFactor(modelKey: string): number {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY_PREFIX + modelKey)
    const v = raw ? Number(raw) : NaN
    return Number.isFinite(v) && v > 0 ? v : 1
  } catch {
    return 1
  }
}

/**
 * 流结束校准：用最终 usage 真值（含思考 token，与估算口径一致）更新 modelKey 的乘法因子。
 * EMA + 离群剔除，防止 usage 异常样本污染因子。
 */
export function calibrate(modelKey: string, baseTokens: number, realTokens: number): void {
  if (baseTokens < CALIBRATION_MIN_BASE || realTokens < CALIBRATION_MIN_REAL) return
  const raw = realTokens / baseTokens
  if (raw < CALIBRATION_CLAMP_MIN || raw > CALIBRATION_CLAMP_MAX) return
  try {
    const key = CALIBRATION_KEY_PREFIX + modelKey
    const prevRaw = Number(localStorage.getItem(key) || '1')
    const prev = Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : 1
    localStorage.setItem(key, String(CALIBRATION_EMA_NEW * raw + CALIBRATION_EMA_OLD * prev))
  } catch {
    // localStorage 不可用（隐私模式等）：本次校准放弃，不影响统计
  }
}
