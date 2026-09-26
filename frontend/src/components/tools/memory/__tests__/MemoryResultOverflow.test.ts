import { mount } from '@vue/test-utils'
import { expect, test } from 'vitest'
import MemoryResult from '../MemoryResult.vue'
import source from '../MemoryResult.vue?raw'

test('长记忆结果保留完整长行，输出区可聚焦滚动且宽度留在卡片内', () => {
  const long = '#0 ' + 'very_long_source_path_without_breaks_'.repeat(100)
  const wrapper = mount(MemoryResult, { props: { toolName: 'memory_wake', args: { part: 1 },
    result: { success: true, data: { text: long + '\nYou are awake.', awake: true, totalMemories: 1 } } } })
  try {
    const output = wrapper.get('pre.memory-text')
    expect(output.text()).toContain(long)
    expect(output.attributes('tabindex')).toBe('0')
    expect(output.attributes('role')).toBe('region')
    expect(source).toContain('overflow-x: auto;')
    expect(source).toContain('min-width: 0;')
    expect(source).toContain('max-width: 100%;')
  } finally { wrapper.unmount() }
})
