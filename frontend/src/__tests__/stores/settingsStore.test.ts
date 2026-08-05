import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../../stores/settingsStore'

describe('settingsStore appearance', () => {
  beforeEach(() => {
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

  it('appearance fields coexist independently (tpsBar toggle does not touch others)', () => {
    const store = useSettingsStore()
    store.setSmoothStreaming('silky')
    store.setSelectionContextEnabled(false)
    store.setTpsBarEnabled(false)
    expect(store.smoothStreaming).toBe('silky')
    expect(store.selectionContextEnabled).toBe(false)
    expect(store.tpsBarEnabled).toBe(false)
  })
})
