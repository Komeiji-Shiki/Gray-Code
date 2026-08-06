/**
 * tokenCounter：模型 token 计数管线（专属 tokenizer + 自校准因子）测试。
 *
 * 覆盖：
 * - 回退估算：tokenizer 未加载时字符类别加权估算可用（>0）
 * - gpt tokenizer：加载后 'hello world' 精确 = 2（cl100k）
 * - DeepSeek 专属 tokenizer：与官方 Python 基准一致的样本（'你好，世界！'=4、'Hello!'=2）
 * - 分批计数：大文本分批与单次编码误差 <1%
 * - 校准：EMA 更新、离群剔除（0.4~2.5）、样本门槛（base<50 跳过）、localStorage 持久化
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  countBaseTokens,
  ensureTokenCounterLoaded,
  getCalibrationFactor,
  calibrate
} from '../tokenCounter'

const CAL_KEY_PREFIX = 'graycode:tpsCal:'

beforeEach(() => {
  localStorage.clear()
})

describe('countBaseTokens - 回退估算（tokenizer 未加载）', () => {
  it('未加载时返回字符类别加权估算（>0）', () => {
    const n = countBaseTokens('hello world 你好', 'gpt-4o')
    expect(n).toBeGreaterThan(0)
  })

  it('空文本返回 0', () => {
    expect(countBaseTokens('', 'gpt-4o')).toBe(0)
  })
})

describe('countBaseTokens - gpt tokenizer（懒加载后精确）', () => {
  it('加载后 hello world = 2（cl100k）', async () => {
    ensureTokenCounterLoaded('gpt-4o')
    // 等待懒加载完成（轮询最多 5s）
    let n = 0
    for (let i = 0; i < 100; i++) {
      n = countBaseTokens('hello world', 'gpt-4o')
      if (n === 2) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(n).toBe(2)
  })
})

describe('countBaseTokens - DeepSeek 专属 tokenizer（与官方基准一致）', () => {
  it('加载后中文/英文样本与官方 Python 基准一致', async () => {
    ensureTokenCounterLoaded('deepseek-chat')
    let zh = 0
    let en = 0
    for (let i = 0; i < 200; i++) {
      zh = countBaseTokens('你好，世界！', 'deepseek-chat')
      en = countBaseTokens('Hello!', 'deepseek-chat')
      if (zh === 4 && en === 2) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(zh).toBe(4)
    expect(en).toBe(2)
  }, 30000)

  it('模型名含 deepseek 时选择专属词表（数值不同）', async () => {
    ensureTokenCounterLoaded('deepseek-chat')
    let ds = 0
    let gpt = 0
    for (let i = 0; i < 200; i++) {
      ds = countBaseTokens('深度学习模型训练', 'deepseek-chat')
      gpt = countBaseTokens('深度学习模型训练', 'gpt-4o')
      if (ds === 3) break
      await new Promise(r => setTimeout(r, 50))
    }
    // 实测：'深度学习模型训练' DeepSeek 词表 = 3 tokens，cl100k = 5 tokens
    expect(ds).toBe(3)
    expect(gpt).toBe(5)
  }, 30000)
})

describe('countBaseTokens - 分批计数', () => {
  it('大文本分批与单次编码误差 <1%', async () => {
    ensureTokenCounterLoaded('gpt-4o')
    const text = 'The quick brown fox jumps over the lazy dog. 中文内容混排 '.repeat(120)
    expect(text.length).toBeGreaterThan(2000)
    let batched = 0
    for (let i = 0; i < 200; i++) {
      batched = countBaseTokens(text, 'gpt-4o')
      if (batched > 100) break
      await new Promise(r => setTimeout(r, 50))
    }
    // 加载完成后单次编码对照
    const { countTokens } = await import('gpt-tokenizer')
    const exact = countTokens(text)
    expect(batched).toBeGreaterThan(0)
    expect(Math.abs(batched - exact) / exact).toBeLessThan(0.01)
  }, 30000)
})

describe('calibrate - 自校准因子', () => {
  it('首次校准：EMA(0.3 新 + 0.7 旧=1)', () => {
    calibrate('model-x', 100, 150) // raw = 1.5
    expect(getCalibrationFactor('model-x')).toBeCloseTo(1.15, 5)
  })

  it('二次校准按 EMA 收敛', () => {
    calibrate('model-x', 100, 150) // factor = 1.15
    calibrate('model-x', 100, 50)  // raw = 0.5 → 0.3*0.5 + 0.7*1.15 = 0.955
    expect(getCalibrationFactor('model-x')).toBeCloseTo(0.955, 5)
  })

  it('离群剔除：raw 超出 0.4~2.5 不更新', () => {
    calibrate('model-x', 100, 300) // raw = 3 > 2.5
    expect(getCalibrationFactor('model-x')).toBe(1)
    calibrate('model-x', 100, 20)  // raw = 0.2 < 0.4
    expect(getCalibrationFactor('model-x')).toBe(1)
  })

  it('样本门槛：base < 50 跳过', () => {
    calibrate('model-x', 40, 80) // raw = 2 但 base 太小
    expect(getCalibrationFactor('model-x')).toBe(1)
  })

  it('不同模型因子独立', () => {
    calibrate('model-a', 100, 200) // raw = 2 → 0.3*2 + 0.7*1 = 1.3
    expect(getCalibrationFactor('model-a')).toBeCloseTo(1.3, 5)
    expect(getCalibrationFactor('model-b')).toBe(1)
  })

  it('因子持久化到 localStorage', () => {
    calibrate('model-x', 100, 100)
    const raw = localStorage.getItem(CAL_KEY_PREFIX + 'model-x')
    expect(raw).toBe('1')
  })

  afterEach(() => {
    localStorage.clear()
  })
})
