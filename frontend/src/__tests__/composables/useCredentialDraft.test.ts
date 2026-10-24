import { describe, expect, test } from 'vitest'
import { randomToken, useCredentialDraft } from '../../composables/useCredentialDraft'

describe('设置页凭据草稿', () => {
  test('读取已保存的值不算修改，保存时不带凭据字段', () => {
    const draft = useCredentialDraft(() => 'web_access')
    draft.load('saved-token')
    expect(draft.token.value).toBe('saved-token')
    expect(draft.updates()).toEqual({})
  })

  test('修改后提交去掉首尾空白的新值，清空则删除已保存的凭据，保存后复位', () => {
    let id = 'speech_fish_key'
    const draft = useCredentialDraft(() => id)
    draft.change('  new-key  ')
    expect(draft.updates()).toEqual({ credentials: { speech_fish_key: 'new-key' }, clearCredentialChanges: [] })
    id = 'speech_openai_key'
    draft.change('   ')
    expect(draft.updates()).toEqual({ credentials: {}, clearCredentialChanges: ['speech_openai_key'] })
    draft.saved()
    expect(draft.updates()).toEqual({})
  })

  test('随机令牌是 64 位十六进制，满足 32 个字符的下限', () => {
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(randomToken()).not.toBe(randomToken())
  })
})
