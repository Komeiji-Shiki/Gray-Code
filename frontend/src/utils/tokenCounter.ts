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
 * 性能：词表初始化与 BPE 编码均在工作线程执行，正文更新不等待计数。
 * 超长文本仍按 2000 字符分片，沿用原有估算口径。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from './vscode'
import TokenizerWorker from './tokenCounter.worker?worker&inline'
import type { TokenizerKind, TokenizerResource, TokenizerRequest, TokenizerResponse } from './tokenCounterEngine'

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

const readyTokenizers = new Set<TokenizerKind>()
/** 加载中 Promise（并发去重） */
const tokenizerLoadPromises = new Map<TokenizerKind, Promise<void>>()
let tokenizerWorker: Worker | null = null
let tokenizerRequestId = 0
const pendingTokenizerRequests = new Map<number, {
  resolve: (response: TokenizerResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

function disposeTokenizerWorker(error: Error): void {
  tokenizerWorker?.terminate()
  tokenizerWorker = null
  readyTokenizers.clear()
  for (const pending of pendingTokenizerRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingTokenizerRequests.clear()
}

function requestTokenizer(request: TokenizerRequest): Promise<TokenizerResponse> {
  if (!tokenizerWorker) {
    tokenizerWorker = new TokenizerWorker({ name: 'graycode-token-counter' })
    tokenizerWorker.onmessage = (event: MessageEvent<TokenizerResponse>) => {
      const pending = pendingTokenizerRequests.get(event.data.id)
      if (!pending) return
      pendingTokenizerRequests.delete(event.data.id)
      clearTimeout(pending.timer)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data)
    }
    tokenizerWorker.onerror = () => disposeTokenizerWorker(new Error('分词工作线程异常'))
    tokenizerWorker.onmessageerror = () => disposeTokenizerWorker(new Error('分词结果无法读取'))
  }
  const worker = tokenizerWorker
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => disposeTokenizerWorker(new Error('分词工作线程超时')), 30_000)
    pendingTokenizerRequests.set(request.id, { resolve, reject, timer })
    try { worker.postMessage(request) } catch (error) {
      pendingTokenizerRequests.delete(request.id)
      clearTimeout(timer)
      reject(error)
    }
  })
}

if (import.meta.hot) import.meta.hot.dispose(() => disposeTokenizerWorker(new Error('分词模块已重新加载')))

/** 按模型名选择专属 tokenizer：DeepSeek 用官方词表，其余用 cl100k（校准因子修正偏差） */
function pickTokenizerKind(modelKey: string): TokenizerKind {
  return modelKey.toLowerCase().includes('deepseek') ? 'deepseek' : 'gpt'
}

/** 字符类别加权基线估算（词表不可用时的回退；CJK 范围参考 tiktoken 常见口径） */
function baseEstimateByCharClass(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
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

/** 词表仍经原通道读取，只把构造过程交给工作线程。 */
async function loadTokenizer(kind: TokenizerKind): Promise<void> {
  const name = kind === 'deepseek' ? 'deepseek-v3' : 'cl100k'
  const resource = await sendToExtension<TokenizerResource>(
    MESSAGE_NAMES['tokenizer.getResource'],
    { name },
    { timeoutMs: 120_000 }
  )
  await requestTokenizer({ id: ++tokenizerRequestId, type: 'load', kind, resource })
  readyTokenizers.add(kind)
}

function ensureLoaded(kind: TokenizerKind): Promise<void> {
  if (readyTokenizers.has(kind)) return Promise.resolve()
  const existing = tokenizerLoadPromises.get(kind)
  if (existing) return existing
  const task = loadTokenizer(kind)
    .catch(() => {
      // 下载/加载失败（离线、源不可达）：保持回退估算；下次会话再试
    })
    .finally(() => {
      tokenizerLoadPromises.delete(kind)
    })
  tokenizerLoadPromises.set(kind, task)
  return task
}

export interface BaseTokenCount {
  tokens: number
  source: 'tokenizer' | 'estimate'
}

/**
 * 异步统计未经校准的 token 数；数组中的文本仍分别计数，保留函数名与参数的边界。
 * 未就绪、失败或工作线程积压时使用原字符估算，并随结果返回实际计数来源。
 */
export async function countBaseTokens(input: string | string[], modelKey: string): Promise<BaseTokenCount> {
  const texts = typeof input === 'string' ? [input] : input
  const kind = pickTokenizerKind(modelKey)
  if (texts.some(Boolean) && readyTokenizers.has(kind) && pendingTokenizerRequests.size < 128) {
    try {
      const result = await requestTokenizer({ id: ++tokenizerRequestId, type: 'count', kind, texts })
      if (result.counts) {
        let source: BaseTokenCount['source'] = 'tokenizer'
        const tokens = result.counts.reduce((total, count, index) => {
          if (count > 0 || !texts[index]) return total + count
          source = 'estimate'
          return total + Math.max(1, Math.ceil(baseEstimateByCharClass(texts[index])))
        }, 0)
        return { tokens, source }
      }
    } catch {
      // 计数失败只影响这次估算，不打断正文接收或把估算标成 tokenizer。
    }
  }
  return { tokens: texts.reduce((total, text) => total + (text ? Math.max(1, Math.ceil(baseEstimateByCharClass(text))) : 0), 0), source: 'estimate' }
}

/** 触发 modelKey 对应 tokenizer 的加载（幂等，通过消息通道向扩展端获取词表） */
export function ensureTokenCounterLoaded(modelKey: string): Promise<void> {
  return ensureLoaded(pickTokenizerKind(modelKey))
}

/** 查询词表是否就绪；实际计数来源随每次结果返回。 */
export function isTokenizerReady(modelKey: string): boolean {
  return readyTokenizers.has(pickTokenizerKind(modelKey))
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
