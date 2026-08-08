import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import StartupBackdrop from '../../components/StartupBackdrop.vue'

describe('StartupBackdrop 灰阶加载动效', () => {
  it('只渲染装饰图层，不提供文字或传统进度控件', () => {
    const wrapper = mount(StartupBackdrop)
    const root = wrapper.get('.startup-backdrop')

    expect(root.attributes('aria-hidden')).toBe('true')
    expect(root.text()).toBe('')
    expect(root.find('.graphite-orbit').exists()).toBe(true)
    expect(root.find('.graphite-horizon').exists()).toBe(true)
  })

  it('使用克制的灰阶动效表达加载，并尊重 reduced-motion', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/StartupBackdrop.vue'),
      'utf8'
    )

    expect(source).toContain('@keyframes graphite-orbit-breathe')
    expect(source).toContain('@keyframes graphite-scan')
    expect(source).toMatch(/\.graphite-horizon::after[\s\S]*animation:\s*graphite-scan/)
    expect(source).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/
    )
  })
})
