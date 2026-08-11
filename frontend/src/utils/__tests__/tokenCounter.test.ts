/**
 * tokenCounter：模型 token 计数管线（运行时词表 + 自校准因子）测试。
 *
 * 词表通过消息通道（tokenizer.getResource）获取，测试 mock 掉 sendToExtension：
 * - cl100k：用 js-tiktoken 内置真实词表（node_modules/dist/ranks/cl100k_base.cjs），
 *   验证 'hello world' = 2（cl100k 精确值）
 * - deepseek-v3：用小型固定词表验证加载路径与模型选择逻辑
 *
 * 覆盖：
 * - 回退估算：词表未就绪时字符类别加权估算可用（>0）
 * - gpt 加载：真实 cl100k 词表精确计数
 * - deepseek 加载：模型名含 deepseek → 请求 deepseek-v3 资源并计数
 * - 分批计数：大文本分批与单次编码误差 <1%
 * - 校准：EMA 更新、离群剔除（0.4~2.5）、样本门槛、localStorage 持久化
 */
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import * as path from 'node:path'

// mock 消息通道：tokenCounter 通过 sendToExtension 向扩展端获取词表
vi.mock('../vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '../vscode'
import {
  countBaseTokens,
  ensureTokenCounterLoaded,
  getCalibrationFactor,
  calibrate
} from '../tokenCounter'

const require = createRequire(import.meta.url)
/** js-tiktoken 内置真实 cl100k 词表（bpe_ranks/pat_str/special_tokens 即 Tiktoken 构造参数） */
// 注意：js-tiktoken 的 exports 未暴露 dist/ranks 子路径，用绝对路径绕过 exports 映射
const cl100kRanks = require(path.resolve(process.cwd(), 'node_modules/js-tiktoken/dist/ranks/cl100k_base.cjs'))

const mockedSend = vi.mocked(sendToExtension)

const CAL_KEY_PREFIX = 'graycode:tpsCal:'

beforeEach(() => {
  localStorage.clear()
  mockedSend.mockReset()
  mockedSend.mockImplementation(async (_type: string, data: { name?: string }) => {
    if (data?.name === 'deepseek-v3') {
      // 小型固定词表：仅 '!'（base64 IQ==，rank 0）
      return { name: 'deepseek-v3', bpeRanks: 'x 0 IQ==\n', patStr: '.+', specialTokens: {} }
    }
    return {
      name: 'cl100k',
      bpeRanks: cl100kRanks.bpe_ranks,
      patStr: cl100kRanks.pat_str,
      specialTokens: cl100kRanks.special_tokens
    }
  })
})

describe('countBaseTokens - 回退估算（词表未就绪）', () => {
  test('未加载时返回字符类别加权估算（>0）', () => {
    const n = countBaseTokens('hello world 你好', 'gpt-4o')
    expect(n).toBeGreaterThan(0)
  })

  test('空文本返回 0', () => {
    expect(countBaseTokens('', 'gpt-4o')).toBe(0)
  })
})

describe('countBaseTokens - cl100k 词表（消息通道加载后精确）', () => {
  test('加载后 hello world = 2（cl100k）', async () => {
    ensureTokenCounterLoaded('gpt-4o')
    let n = 0
    for (let i = 0; i < 100; i++) {
      n = countBaseTokens('hello world', 'gpt-4o')
      if (n === 2) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(n).toBe(2)
    expect(mockedSend).toHaveBeenCalledWith('tokenizer.getResource', { name: 'cl100k' }, expect.anything())
  })
})

describe('countBaseTokens - DeepSeek 资源路径', () => {
  test('模型名含 deepseek 时请求 deepseek-v3 资源并计数', async () => {
    ensureTokenCounterLoaded('deepseek-chat')
    let n = 0
    for (let i = 0; i < 100; i++) {
      n = countBaseTokens('!', 'deepseek-chat')
      if (n === 1) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(n).toBe(1)
    expect(mockedSend).toHaveBeenCalledWith('tokenizer.getResource', { name: 'deepseek-v3' }, expect.anything())
  }, 30000)
})

describe('countBaseTokens - 分批计数', () => {
  test('大文本分批与单次编码误差 <1%', async () => {
    ensureTokenCounterLoaded('gpt-4o')
    const text = 'The quick brown fox jumps over the lazy dog. 中文内容混排 '.repeat(120)
    expect(text.length).toBeGreaterThan(2000)
    let batched = 0
    for (let i = 0; i < 200; i++) {
      batched = countBaseTokens(text, 'gpt-4o')
      if (batched > 100) break
      await new Promise(r => setTimeout(r, 50))
    }
    // 单次编码对照（直接用同一词表构造）
    const { Tiktoken } = await import('js-tiktoken/lite')
    const enc = new Tiktoken({
      bpe_ranks: cl100kRanks.bpe_ranks,
      pat_str: cl100kRanks.pat_str,
      special_tokens: cl100kRanks.special_tokens
    })
    const exact = enc.encode(text).length
    expect(batched).toBeGreaterThan(0)
    expect(Math.abs(batched - exact) / exact).toBeLessThan(0.01)
  }, 30000)
})

describe('calibrate - 自校准因子', () => {
  test('首次校准：EMA(0.3 新 + 0.7 旧=1)', () => {
    calibrate('model-x', 100, 150) // raw = 1.5
    expect(getCalibrationFactor('model-x')).toBeCloseTo(1.15, 5)
  })

  test('二次校准按 EMA 收敛', () => {
    calibrate('model-x', 100, 150) // factor = 1.15
    calibrate('model-x', 100, 50)  // raw = 0.5 → 0.3*0.5 + 0.7*1.15 = 0.955
    expect(getCalibrationFactor('model-x')).toBeCloseTo(0.955, 5)
  })

  test('离群剔除：raw 超出 0.4~2.5 不更新', () => {
    calibrate('model-x', 100, 300) // raw = 3 > 2.5
    expect(getCalibrationFactor('model-x')).toBe(1)
    calibrate('model-x', 100, 20)  // raw = 0.2 < 0.4
    expect(getCalibrationFactor('model-x')).toBe(1)
  })

  test('样本门槛：base < 50 跳过', () => {
    calibrate('model-x', 40, 80) // raw = 2 但 base 太小
    expect(getCalibrationFactor('model-x')).toBe(1)
  })

  test('不同模型因子独立', () => {
    calibrate('model-a', 100, 200) // raw = 2 → 0.3*2 + 0.7*1 = 1.3
    expect(getCalibrationFactor('model-a')).toBeCloseTo(1.3, 5)
    expect(getCalibrationFactor('model-b')).toBe(1)
  })

  test('因子持久化到 localStorage', () => {
    calibrate('model-x', 100, 100)
    const raw = localStorage.getItem(CAL_KEY_PREFIX + 'model-x')
    expect(raw).toBe('1')
  })

  afterEach(() => {
    localStorage.clear()
  })
})
