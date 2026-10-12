import { describe, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../../stores/settingsStore'

describe('settingsStore appearance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('tpsBarEnabled defaults to true and can be toggled', () => {
    const store = useSettingsStore()
    expect(store.tpsBarEnabled).toBe(true)
    store.setTpsBarEnabled(false)
    expect(store.tpsBarEnabled).toBe(false)
    store.setTpsBarEnabled(true)
    expect(store.tpsBarEnabled).toBe(true)
  })

  test('splashEnabled defaults to true and can be toggled', () => {
    const store = useSettingsStore()
    expect(store.splashEnabled).toBe(true)
    store.setSplashEnabled(false)
    expect(store.splashEnabled).toBe(false)
    store.setSplashEnabled(true)
    expect(store.splashEnabled).toBe(true)
  })

  test('appearance fields coexist independently (tpsBar toggle does not touch others)', () => {
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

  test('旧总结与计数页签 ID 统一打开上下文设置', () => {
    const store = useSettingsStore()
    store.showSettings('summarize')
    expect(store.currentView).toBe('settings')
    expect(store.activeTab).toBe('context')
    store.setActiveTab('tokenCount')
    expect(store.activeTab).toBe('context')
  })
})
