import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../../stores/settingsStore'

describe('settingsStore appearance', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('tpsBarEnabled defaults to true and can be toggled', () => {
    const store = useSettingsStore()
    expect(store.tpsBarEnabled).toBe(true)
    store.setTpsBarEnabled(false)
    expect(store.tpsBarEnabled).toBe(false)
    store.setTpsBarEnabled(true)
    expect(store.tpsBarEnabled).toBe(true)
  })

  it('splashEnabled defaults to true and can be toggled', () => {
    const store = useSettingsStore()
    expect(store.splashEnabled).toBe(true)
    store.setSplashEnabled(false)
    expect(store.splashEnabled).toBe(false)
    store.setSplashEnabled(true)
    expect(store.splashEnabled).toBe(true)
  })

  it('splashEnabled 关闭时写入首帧画面开关标记（gc-splash-disabled），重开时清除', () => {
    const store = useSettingsStore()
    store.setSplashEnabled(false)
    expect(localStorage.getItem('gc-splash-disabled')).toBe('1')
    store.setSplashEnabled(true)
    expect(localStorage.getItem('gc-splash-disabled')).toBeNull()
  })

  it('初始化时读取 gc-splash-disabled 标记：已关闭动画的用户首帧即不渲染 Splash（桌面无同步注入场景）', () => {
    localStorage.setItem('gc-splash-disabled', '1')
    const store = useSettingsStore()
    expect(store.splashEnabled).toBe(false)
  })

  it('gc-splash-disabled 标记缺失时初始默认开启 Splash', () => {
    localStorage.removeItem('gc-splash-disabled')
    const store = useSettingsStore()
    expect(store.splashEnabled).toBe(true)
  })

  it('appearance fields coexist independently (tpsBar toggle does not touch others)', () => {
    const store = useSettingsStore()
    store.setSmoothStreaming('silky')
    store.setSelectionContextEnabled(false)
    store.setTpsBarEnabled(false)
    store.setSplashEnabled(false)
    expect(store.smoothStreaming).toBe('silky')
    expect(store.selectionContextEnabled).toBe(false)
    expect(store.tpsBarEnabled).toBe(false)
    expect(store.splashEnabled).toBe(false)
  })
})
