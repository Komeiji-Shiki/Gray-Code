import { describe, expect, test } from 'vitest'
import { randomUuid } from '@shared/randomUuid'

describe('randomUuid', () => {
  test('在缺少 randomUUID 的环境生成 v4 标识', () => {
    let seed = 0
    const value = randomUuid({
      getRandomValues: bytes => {
        for (let index = 0; index < bytes.length; index++) bytes[index] = (seed++ * 31 + 7) & 255
        return bytes
      }
    })
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
