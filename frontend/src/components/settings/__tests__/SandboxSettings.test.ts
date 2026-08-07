/**
 * SandboxSettings 测试（SANDBOX-01）
 *
 * 覆盖：
 * - 挂载时加载沙箱配置（getSandboxConfig）并同步后端默认值（getDefaultSandboxConfig）
 * - 空白名单是合法配置（= 拒绝全部语言），加载后不回退成全选
 * - 总开关乐观更新：成功调用 updateSandboxConfig，失败回滚
 * - 保存配置的 payload 结构
 * - 语言白名单为空时禁止保存
 * - 恢复默认：调用 getDefaultSandboxConfig 并立即保存
 * - 数字输入保存时钳制到合法范围
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SandboxSettings from '../SandboxSettings.vue'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '@/utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

const DEFAULT_CONFIG = {
  enabled: false,
  allowedLanguages: ['python', 'javascript', 'bash', 'powershell', 'sh'],
  defaultTimeout: 30000,
  maxOutputLines: 200,
  cleanupTempDir: true
}

function defaultSendImplementation() {
  mockSend.mockImplementation((type: string, _payload: any) => {
    switch (type) {
      case 'getDefaultSandboxConfig':
        return Promise.resolve({ ...DEFAULT_CONFIG })
      case 'getSandboxConfig':
        return Promise.resolve({ ...DEFAULT_CONFIG })
      case 'updateSandboxConfig':
        return Promise.resolve({ success: true })
      default:
        return Promise.resolve({})
    }
  })
}

async function mountSettings() {
  const wrapper = mount(SandboxSettings)
  await flushPromises()
  return wrapper
}

describe('SandboxSettings', () => {
  beforeEach(() => {
    defaultSendImplementation()
  })

  afterEach(() => {
    mockSend.mockReset()
  })

  it('挂载时加载沙箱配置与后端默认值', async () => {
    await mountSettings()

    expect(mockSend).toHaveBeenCalledWith('getSandboxConfig', {})
    expect(mockSend).toHaveBeenCalledWith('getDefaultSandboxConfig', {})
    // 总开关默认关闭
    expect(mockSend).not.toHaveBeenCalledWith('updateSandboxConfig', expect.anything())
  })

  it('空白名单是合法配置：加载后保持为空，不回退成全选', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'getSandboxConfig') {
        return Promise.resolve({ ...DEFAULT_CONFIG, allowedLanguages: [] })
      }
      if (type === 'getDefaultSandboxConfig') {
        return Promise.resolve({ ...DEFAULT_CONFIG })
      }
      return Promise.resolve({ success: true })
    })
    const wrapper = await mountSettings()

    const checkedBoxes = wrapper.findAll('.language-item input[type="checkbox"]')
    const checked = checkedBoxes.filter(b => (b.element as HTMLInputElement).checked)
    expect(checked.length).toBe(0)
  })

  it('总开关切换：乐观更新并调用 updateSandboxConfig', async () => {
    const wrapper = await mountSettings()

    const toggle = wrapper.findAll('input[type="checkbox"]').find(b => (b.element as HTMLInputElement).checked === false)
    expect(toggle).toBeTruthy()
    await toggle!.setValue(true)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('updateSandboxConfig', { config: { enabled: true } })
  })

  it('总开关切换失败：回滚为原状态', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'updateSandboxConfig') {
        return Promise.reject(new Error('boom'))
      }
      if (type === 'getSandboxConfig') {
        return Promise.resolve({ ...DEFAULT_CONFIG, enabled: true })
      }
      if (type === 'getDefaultSandboxConfig') {
        return Promise.resolve({ ...DEFAULT_CONFIG })
      }
      return Promise.resolve({})
    })
    const wrapper = await mountSettings()

    const toggle = wrapper.findAll('input[type="checkbox"]').find(b => (b.element as HTMLInputElement).checked === true)
    await toggle!.setValue(false)
    await flushPromises()

    const toggleAfter = wrapper.findAll('input[type="checkbox"]').find(b => (b.element as HTMLInputElement).checked === true)
    // 失败后回滚为启用状态
    expect(toggleAfter).toBeTruthy()
  })

  it('保存配置：payload 包含语言白名单与数值项', async () => {
    const wrapper = await mountSettings()
    // 启用沙箱（解锁配置区）
    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
    await flushPromises()

    await wrapper.find('button.save-btn').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('updateSandboxConfig', {
      config: expect.objectContaining({
        allowedLanguages: expect.arrayContaining(['python', 'javascript', 'bash', 'powershell', 'sh']),
        defaultTimeout: 30000,
        maxOutputLines: 200,
        cleanupTempDir: true
      })
    })
  })

  it('语言白名单为空时禁止保存并展示错误', async () => {
    const wrapper = await mountSettings()
    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
    await flushPromises()

    // 取消勾选全部 5 种语言
    const langBoxes = wrapper.findAll('.language-item input[type="checkbox"]')
    for (const box of langBoxes) {
      await box.setValue(false)
    }
    await wrapper.find('button.save-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.save-message.error').exists()).toBe(true)
    // 未发出保存请求（updateSandboxConfig 仅来自总开关那一次）
    const updateCalls = mockSend.mock.calls.filter((c: any[]) => c[0] === 'updateSandboxConfig')
    expect(updateCalls.length).toBe(1)
  })

  it('恢复默认：获取后端默认值并立即保存', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'getSandboxConfig') {
        return Promise.resolve({
          ...DEFAULT_CONFIG,
          enabled: true,
          allowedLanguages: ['python'],
          defaultTimeout: 9999,
          maxOutputLines: 5,
          cleanupTempDir: false
        })
      }
      if (type === 'getDefaultSandboxConfig') {
        return Promise.resolve({ ...DEFAULT_CONFIG })
      }
      return Promise.resolve({ success: true })
    })
    const wrapper = await mountSettings()

    await wrapper.find('button.reset-btn').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('updateSandboxConfig', {
      config: expect.objectContaining({
        allowedLanguages: ['python', 'javascript', 'bash', 'powershell', 'sh'],
        defaultTimeout: 30000,
        maxOutputLines: 200,
        cleanupTempDir: true
      })
    })
  })

  it('数字输入越界时保存前钳制到合法范围', async () => {
    const wrapper = await mountSettings()
    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
    await flushPromises()

    const inputs = wrapper.findAll('input.number-input')
    // 超时输入越界值
    await inputs[0].setValue(99999999)
    // 输出行数输入 -999
    await inputs[1].setValue(-999)
    await wrapper.find('button.save-btn').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('updateSandboxConfig', {
      config: expect.objectContaining({
        defaultTimeout: 600000,
        maxOutputLines: 1
      })
    })
  })
})
