/**
 * 模型 token 计数管线（tokenizer + 自校准叠加）。
 *
 * 精度阶梯（多提供商场景下 tokenizer 不是终点，需叠加校准）：
 * 1. 模型专属 tokenizer（最高精度基线）：
 *    - DeepSeek：官方 deepseek_v3_tokenizer 转换词表（js-tiktoken/lite 加载，
 *      frontend/src/vendor/deepseek-tokenizer/，已与官方 Python 基准逐位一致）；
 *    - 其余模型：gpt-tokenizer（cl100k_base）——对 OpenAI 系近精确，对其他模型有
 *      系统性偏差（5~20%），由下面的校准因子修正。
 * 2. 自校准因子（按 modelKey 持久化到 localStorage）：每轮流结束拿最终 usage 真值
 *    （candidatesTokenCount，含思考 token，与估算端计入 thought 的口径一致）对比本轮
 *    base 估算，EMA 学习乘法因子；离群剔除（0.4~2.5）挡 usage 异常样本（字段缺失/
 *    多轮混合/截断等）。同一模型的系统性偏差稳定，因子收敛后误差压到 ~3~5%，且对
 *    词表不匹配的模型自动修正。
 * 3. 回退：tokenizer 未加载/加载失败时字符类别加权估算（ASCII/CJK/其他分系数），
 *    同样乘校准因子。
 *
 * 性能与体积：
 * - 词表均懒加载（dynamic import 独立 chunk）：gpt ~1MB、deepseek ~2.3MB，首次
 *   遇到对应模型才拉取；加载完成前走回退估算，不阻塞业务。
 * - 同步编码：常规 chunk <1ms；超长文本分批（BATCH_SIZE 字符/片）规避大输入时
 *   合并缓存的非线性退化（实测 300k 字符分批 ~380ms、误差 <0.2%）。
 */

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

let gptCount: ((text: string) => number) | null = null
let deepseekCount: ((text: string) => number) | null = null
const loadPromises: Partial<Record<TokenizerKind, Promise<void>>> = {}

/** 按模型名选择专属 tokenizer：DeepSeek 用官方词表，其余用 gpt（校准因子修正偏差） */
function pickTokenizerKind(modelKey: string): TokenizerKind {
  return modelKey.toLowerCase().includes('deepseek') ? 'deepseek' : 'gpt'
}

/** 字符类别加权基线估算（tokenizer 不可用时的回退；CJK 范围参考 tiktoken 常见口径） */
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

function ensureLoaded(kind: TokenizerKind): void {
  if ((kind === 'gpt' && gptCount) || (kind === 'deepseek' && deepseekCount)) return
  if (loadPromises[kind]) return
  loadPromises[kind] = (async () => {
    try {
      if (kind === 'gpt') {
        const mod = await import('gpt-tokenizer')
        gptCount = (text: string) => mod.countTokens(text)
      } else {
        const [{ Tiktoken }, metaRaw, ranksRaw] = await Promise.all([
          import('js-tiktoken/lite'),
          import('../vendor/deepseek-tokenizer/meta.json?raw'),
          import('../vendor/deepseek-tokenizer/deepseek.tiktoken?raw')
        ])
        const meta = JSON.parse(metaRaw.default) as {
          pat_str: string
          special_tokens: Record<string, number>
        }
        const enc = new Tiktoken({
          bpe_ranks: ranksRaw.default,
          pat_str: meta.pat_str,
          special_tokens: meta.special_tokens
        })
        deepseekCount = (text: string) => enc.encode(text).length
      }
    } catch {
      // 加载失败（离线/构建异常）：保持回退估算，不阻塞业务
    }
  })().finally(() => {
    loadPromises[kind] = undefined
  })
}

function countWith(fn: ((text: string) => number) | null, text: string): number | null {
  if (!fn) return null
  if (text.length <= BATCH_SIZE) return fn(text)
  let total = 0
  for (let i = 0; i < text.length; i += BATCH_SIZE) {
    total += fn(text.slice(i, i + BATCH_SIZE))
  }
  return total
}

/**
 * 统计文本的 base token 数（同步，未经校准因子修正）。
 * 按 modelKey 选择专属 tokenizer；未加载/失败时回退字符类别加权估算。
 */
export function countBaseTokens(text: string, modelKey: string): number {
  if (!text) return 0
  const kind = pickTokenizerKind(modelKey)
  const counted = kind === 'deepseek'
    ? countWith(deepseekCount, text)
    : countWith(gptCount, text)
  if (counted !== null && counted > 0) return counted
  return Math.max(1, Math.ceil(baseEstimateByCharClass(text)))
}

/** 触发 modelKey 对应 tokenizer 的懒加载（幂等） */
export function ensureTokenCounterLoaded(modelKey: string): void {
  ensureLoaded(pickTokenizerKind(modelKey))
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
 * 流结束校准：用最终 usage 真值（剔除 reasoning tokens）更新 modelKey 的乘法因子。
 * EMA + 离群剔除，防止推理模型 usage 污染因子。
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
