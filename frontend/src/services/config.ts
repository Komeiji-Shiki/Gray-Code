import { MESSAGE_NAMES } from '@shared/protocol'
import type { PromptMode } from '../components/input/types'
import type { ModelInfo, ChannelConfig } from '../types'
import { sendToExtension } from '../utils/vscode'

export async function listConfigIds(): Promise<string[]> {
  return await sendToExtension<string[]>(MESSAGE_NAMES['config.listConfigs'], {})
}

/**
 * 获取单个渠道配置。
 *
 * 泛型 T 允许调用方声明更窄的配置子类型；默认返回 ChannelConfig 契约类型，
 * 替代原先的 Promise<any>。
 */
export async function getConfig<T extends ChannelConfig = ChannelConfig>(configId: string): Promise<T> {
  return await sendToExtension<T>(MESSAGE_NAMES['config.getConfig'], { configId })
}

/**
 * 更新渠道配置。
 *
 * updates 收窄为渠道配置字段的子集（排除后端自管字段 id/createdAt/updatedAt），
 * 替代原先的 Record<string, any>，拼错字段名时由编译器兜底。
 */
export async function updateConfig<T extends ChannelConfig = ChannelConfig>(
  configId: string,
  updates: Partial<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<T> {
  return await sendToExtension<T>(MESSAGE_NAMES['config.updateConfig'], { configId, updates })
}

export async function getPromptModes() {
  return await sendToExtension<{
    modes: PromptMode[]
    currentModeId: string
    dynamicContextStrategy?: 'single' | 'preserve'
  }>(MESSAGE_NAMES.getPromptModes, {})
}

export async function setCurrentPromptMode(modeId: string) {
  return await sendToExtension(MESSAGE_NAMES.setCurrentPromptMode, { modeId })
}

export async function getChannelModels(configId: string): Promise<ModelInfo[]> {
  return await sendToExtension<ModelInfo[]>(MESSAGE_NAMES['models.getModels'], { configId })
}
