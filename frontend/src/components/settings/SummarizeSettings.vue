<script setup lang="ts">
/**
 * SummarizeSettings - 总结设置面板
 * 配置上下文总结功能
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { useDesktopSettingsDraft, markDesktopSettingsDirty } from '@/platform/settingsDraft'
import { reactive, ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { CustomCheckbox, CustomSelect, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useDeferredNumberInput, getSettingsView } from '@/composables/useDeferredNumberInput'
import type { ModelInfo, SummarizeConfig } from '@/types'

const { t } = useI18n()
const standaloneContext = !!window.__GRAYCODE_HOST

// 渠道配置类型
interface ChannelConfig {
  id: string
  name: string
  type: string
  enabled: boolean
  model: string
  models: ModelInfo[]
}

// 渠道列表
const channels = ref<ChannelConfig[]>([])
const isLoadingChannels = ref(false)
const configLoaded = ref(false)

// 总结配置
const summarizeConfig = reactive<SummarizeConfig>({
  method: 'summary',
  userMessageRetention: 'first',
  // 手动总结提示词
  summarizePrompt: '请将以上对话内容进行总结，保留关键信息和上下文要点，去除冗余内容。',
  // 自动总结提示词
  autoSummarizePrompt: '',
  // 最少保留最近 N 轮不总结（保留预算的下限保护）
  keepRecentRounds: 2,
  // 总结时保留最近内容的 token 预算（绝对 token 数或百分比；百分比基数为待总结活跃历史总量，'50%' = 截断一半保留一半），默认值由后端下发
  keepRecentTokens: '' as string | number,
  // 使用专门的总结模型
  useSeparateModel: false,
  // 总结用的渠道 ID
  summarizeChannelId: '',
  // 总结用的模型 ID
  summarizeModelId: '',
  // 单个真实用户回合内自动总结的最大尝试次数（1-5，默认 2）
  maxAutoSummarizeAttemptsPerTurn: 2,
  // 自动总结单次请求输入占总结模型上下文窗口的比例（0-1，默认 0.5）
  summarizeMaxInputRatio: 0.5
})

// 内置默认总结配置（用于“恢复内置默认”与空值回落，由后端 DEFAULT_SUMMARIZE_CONFIG 下发）
const defaultSummarizeConfig = ref({
  summarizePrompt: summarizeConfig.summarizePrompt,
  autoSummarizePrompt: summarizeConfig.autoSummarizePrompt,
  keepRecentTokens: '' as string | number,
  maxAutoSummarizeAttemptsPerTurn: 2,
  summarizeMaxInputRatio: 0.5
})

const hasManualDefaultPrompt = computed(() =>
  !!defaultSummarizeConfig.value.summarizePrompt?.trim()
)

const hasAutoDefaultPrompt = computed(() =>
  !!defaultSummarizeConfig.value.autoSummarizePrompt?.trim()
)

// 草稿模式：清空后不立即回填默认值；离开设置页时自动回填已保存值
const {
  draft: keepRecentRoundsDraft,
  handleInput: handleKeepRecentRoundsInput,
  syncFromStored: syncKeepRecentRoundsFromStored
} = useDeferredNumberInput(() => summarizeConfig.keepRecentRounds)
const {
  draft: maxAttemptsDraft,
  handleInput: handleMaxAttemptsInput,
  syncFromStored: syncMaxAttemptsFromStored
} = useDeferredNumberInput(() => summarizeConfig.maxAutoSummarizeAttemptsPerTurn, v => v >= 1 && v <= 5)
const {
  draft: maxInputRatioDraft,
  handleInput: handleMaxInputRatioInput,
  syncFromStored: syncMaxInputRatioFromStored
} = useDeferredNumberInput(
  () => (summarizeConfig.summarizeMaxInputRatio === undefined ? undefined : Math.round(summarizeConfig.summarizeMaxInputRatio * 100)),
  v => v >= 5 && v <= 95
)

// 保留预算：数字或百分比文本，允许编辑期间为空；离开设置页时回填已保存值
const keepRecentTokensDraft = ref('')
function syncKeepRecentTokensFromStored() {
  const stored = summarizeConfig.keepRecentTokens
  keepRecentTokensDraft.value = stored === undefined || stored === null ? '' : String(stored)
}
function handleKeepRecentTokensInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  keepRecentTokensDraft.value = raw
  const text = raw.trim()
  if (!text) {
    // 清空 = 恢复后端内置默认（旧 updateKeepRecentTokens 行为，PR 移除后 UI 上不可达）
    const fallback = defaultSummarizeConfig.value.keepRecentTokens
    if (fallback !== undefined && fallback !== null) {
      keepRecentTokensDraft.value = String(fallback)
      void updateConfigField('keepRecentTokens', fallback)
    }
    return
  }
  const value = /^\d+$/.test(text) ? Number(text) : text
  void updateConfigField('keepRecentTokens', value)
}
watch(
  getSettingsView,
  (view) => {
    if (view !== 'settings') {
      if (!keepRecentTokensDraft.value.trim()) syncKeepRecentTokensFromStored()
    }
  }
)
syncKeepRecentTokensFromStored()

async function restorePromptToDefault(kind: 'manual' | 'auto') {
  const field = kind === 'manual' ? 'summarizePrompt' : 'autoSummarizePrompt'
  const value = kind === 'manual' ? defaultSummarizeConfig.value.summarizePrompt : defaultSummarizeConfig.value.autoSummarizePrompt
  await updateConfigField(field, value)
}

// 已启用的渠道选项
const enabledChannelOptions = computed<SelectOption[]>(() => {
  return channels.value
    .filter(c => c.enabled)
    .map(c => ({
      value: c.id,
      label: c.name,
      description: c.type
    }))
})

// 当前选择的渠道
const selectedChannel = computed(() => {
  return channels.value.find(c => c.id === summarizeConfig.summarizeChannelId)
})

// 当前渠道的模型选项
const modelOptions = computed<SelectOption[]>(() => {
  if (!selectedChannel.value || !selectedChannel.value.models) {
    return []
  }
  return selectedChannel.value.models.map(m => ({
    value: m.id,
    label: m.name || m.id,
    description: m.description
  }))
})

// 加载渠道列表
async function loadChannels() {
  isLoadingChannels.value = true
  try {
    const ids = await sendToExtension<string[]>(MESSAGE_NAMES['config.listConfigs'], {})
    const loadedChannels: ChannelConfig[] = []
    
    for (const id of ids) {
      const config = await sendToExtension<ChannelConfig>(MESSAGE_NAMES['config.getConfig'], { configId: id })
      if (config) {
        loadedChannels.push(config)
      }
    }
    
    channels.value = loadedChannels
  } catch (error) {
    console.error('Failed to load channels:', error)
  } finally {
    isLoadingChannels.value = false
  }
}

// 加载配置
async function loadConfig() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getSummarizeConfig, {})
    if (response) {
      const merged = { ...response }

      // 历史配置兼容：如果提示词为空，前端展示内置默认值（避免显示空白）
      if (typeof merged.summarizePrompt !== 'string' || !merged.summarizePrompt.trim()) {
        merged.summarizePrompt = defaultSummarizeConfig.value.summarizePrompt
      }
      if (typeof merged.autoSummarizePrompt !== 'string' || !merged.autoSummarizePrompt.trim()) {
        merged.autoSummarizePrompt = defaultSummarizeConfig.value.autoSummarizePrompt
      }

      Object.assign(summarizeConfig, merged)
      syncKeepRecentRoundsFromStored()
      syncMaxAttemptsFromStored()
      syncMaxInputRatioFromStored()
      syncKeepRecentTokensFromStored()
      configLoaded.value = true
    }
  } catch (error) {
    console.error('Failed to load summarize config:', error)
  }
}

// 加载内置默认配置（用于恢复按钮）
async function loadDefaultConfig() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getDefaultSummarizeConfig, {})
    if (response) {
      defaultSummarizeConfig.value = {
        summarizePrompt:
          typeof response.summarizePrompt === 'string'
            ? response.summarizePrompt
            : summarizeConfig.summarizePrompt,
        autoSummarizePrompt:
          typeof response.autoSummarizePrompt === 'string'
            ? response.autoSummarizePrompt
            : summarizeConfig.autoSummarizePrompt,
        keepRecentTokens:
          typeof response.keepRecentTokens === 'string' || typeof response.keepRecentTokens === 'number'
            ? response.keepRecentTokens
            : defaultSummarizeConfig.value.keepRecentTokens,
        maxAutoSummarizeAttemptsPerTurn:
          typeof response.maxAutoSummarizeAttemptsPerTurn === 'number'
            ? response.maxAutoSummarizeAttemptsPerTurn
            : defaultSummarizeConfig.value.maxAutoSummarizeAttemptsPerTurn,
        summarizeMaxInputRatio:
          typeof response.summarizeMaxInputRatio === 'number'
            ? response.summarizeMaxInputRatio
            : defaultSummarizeConfig.value.summarizeMaxInputRatio
      }
    }
  } catch (error) {
    console.error('Failed to load default summarize config:', error)
  }
}

// 更新配置字段（即时更新本地值 + 防抖保存）
// @input 每按键触发：统一 400ms 防抖提交，避免每按键全量写配置
let configSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null

async function updateConfigField<K extends keyof SummarizeConfig>(field: K, value: SummarizeConfig[K]) {
  // 先更新本地值（即时反馈）
  summarizeConfig[field] = value
  // 自定义下拉框只发组件事件，不会冒泡原生 input/change；立即保存也必须提交新选择。
  markDesktopSettingsDirty()
  scheduleConfigSave()
}

// 防抖调度保存
function scheduleConfigSave() {
  if (configSaveDebounceTimer) {
    clearTimeout(configSaveDebounceTimer)
  }
  configSaveDebounceTimer = setTimeout(() => {
    configSaveDebounceTimer = null
    void persistConfig()
  }, 400)
}

// 保存到后端（快照当前配置）
async function persistConfig() {
  try {
    await sendToExtension(MESSAGE_NAMES.updateSummarizeConfig, {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 更新渠道选择
async function updateChannelId(channelId: string) {
  summarizeConfig.summarizeChannelId = channelId
  // 切换渠道时，清空模型选择
  summarizeConfig.summarizeModelId = ''
  
  // 保存到后端
  try {
    await sendToExtension(MESSAGE_NAMES.updateSummarizeConfig, {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 更新模型选择
async function updateModelId(modelId: string) {
  summarizeConfig.summarizeModelId = modelId
  
  // 保存到后端
  try {
    await sendToExtension(MESSAGE_NAMES.updateSummarizeConfig, {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 监听专用模型开关
watch(() => summarizeConfig.useSeparateModel, (enabled) => {
  if (!enabled) {
    // 关闭时清空渠道和模型选择，并同步持久化
    // （否则清空只停留在本地，重进设置页会回显旧值）
    summarizeConfig.summarizeChannelId = ''
    summarizeConfig.summarizeModelId = ''
    void persistConfig()
  }
})

// 初始化
onMounted(async () => {
  await loadDefaultConfig()
  // 独立宿主沿用当前会话模型，不需要读取隐藏的专用模型渠道列表。
  await Promise.all([loadConfig(), ...(standaloneContext ? [] : [loadChannels()])])
})

function cancelConfigSave() {
  if (configSaveDebounceTimer) clearTimeout(configSaveDebounceTimer)
  configSaveDebounceTimer = null
}
useDesktopSettingsDraft(async () => {
  // 统一保存和分类跳转先提交最后的输入，撤销时则取消尚未发送的请求。
  cancelConfigSave()
  await persistConfig()
}, () => configLoaded.value, cancelConfigSave)
onUnmounted(() => {
  // 独立宿主由统一草稿处理；旧扩展仍在离开前保存尚未提交的输入。
  if (configSaveDebounceTimer) {
    cancelConfigSave()
    if (!standaloneContext) void persistConfig()
  }
})
</script>

<template>
  <div class="summarize-settings">
    <!-- 功能说明 -->
    <div class="feature-description">
      <i class="codicon codicon-info"></i>
      <p>
        {{ t(standaloneContext ? 'components.settings.summarizeSettings.methodControls.description' : 'components.settings.summarizeSettings.description') }}
      </p>
    </div>
    
    <div v-if="standaloneContext" class="section" data-search-anchor="context-method">
      <h5 class="section-title">{{ t('components.settings.summarizeSettings.methodControls.defaultTitle') }}</h5>
      <CustomSelect :model-value="summarizeConfig.method ?? 'summary'" :options="[{ value: 'summary', label: t('components.tools.contextStatus.summaryOption') }, { value: 'notes', label: t('components.tools.contextStatus.notesOption') }]" @update:model-value="value => updateConfigField('method', value as 'summary' | 'notes')" />
      <p v-if="summarizeConfig.method !== 'notes'" class="field-hint">{{ t('components.settings.summarizeSettings.retention.summaryHint') }}</p>
      <p v-else class="field-hint">{{ t('components.settings.summarizeSettings.retention.notesHint') }}</p>
      <p class="field-hint">{{ t('components.settings.summarizeSettings.methodControls.defaultHint') }}</p>
    </div>

    <div v-if="standaloneContext" class="section" data-search-anchor="context-user-retention">
      <h5 class="section-title">{{ t('components.settings.summarizeSettings.retention.title') }}</h5>
      <CustomSelect :model-value="summarizeConfig.userMessageRetention ?? 'first'"
        :options="[{ value: 'first', label: t('components.settings.summarizeSettings.retention.first') }, { value: 'all', label: t('components.settings.summarizeSettings.retention.all') }]"
        @update:model-value="value => updateConfigField('userMessageRetention', value as 'first' | 'all')" />
      <p class="field-hint">{{ t('components.settings.summarizeSettings.retention.hint') }}</p>
    </div>

    <!-- 手动总结说明 -->
    <div v-if="!standaloneContext" class="section" data-search-anchor="summarize-manual">
      <h5 class="section-title">
        <i class="codicon codicon-fold"></i>
        {{ t('components.settings.summarizeSettings.manualSection.title') }}
      </h5>
      <p class="section-description">
        {{ t('components.settings.summarizeSettings.manualSection.description') }}
      </p>
    </div>
    
    <!-- 总结选项 -->
    <div class="section" data-search-anchor="summarize-options">
      <h5 class="section-title">
        <i class="codicon codicon-settings"></i>
        {{ t('components.settings.summarizeSettings.optionsSection.title') }}
      </h5>
      
      <div v-if="!standaloneContext" class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.keepRounds') }}</label>
        <div class="rounds-input">
          <input
            type="number"
            :value="keepRecentRoundsDraft"
            min="1"
            max="10"
            @input="(e: any) => handleKeepRecentRoundsInput(e.target.value, v => updateConfigField('keepRecentRounds', v))"
          />
          <span class="unit">{{ t('components.settings.summarizeSettings.optionsSection.keepRoundsUnit') }}</span>
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.keepRoundsHint') }}</p>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.keepRoundsMinNote') }}</p>
      </div>

      <div v-if="!standaloneContext" class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.keepTokens') }}</label>
        <div class="rounds-input">
          <input
            type="text"
            :value="keepRecentTokensDraft"
            :placeholder="String(defaultSummarizeConfig.keepRecentTokens ?? '')"
            @change="handleKeepRecentTokensInput"
          />
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.keepTokensHint') }}</p>
      </div>

      <div v-if="!standaloneContext" class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.maxAttempts') }}</label>
        <div class="rounds-input">
          <input
            type="number"
            :value="maxAttemptsDraft"
            min="1"
            max="5"
            @change="(e: any) => handleMaxAttemptsInput(e.target.value, v => updateConfigField('maxAutoSummarizeAttemptsPerTurn', v))"
          />
          <span class="unit">{{ t('components.settings.summarizeSettings.optionsSection.maxAttemptsUnit') }}</span>
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.maxAttemptsHint') }}</p>
      </div>

      <div v-if="!standaloneContext" class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.maxInputRatio') }}</label>
        <div class="rounds-input">
          <input
            type="number"
            :value="maxInputRatioDraft"
            min="5"
            max="95"
            @change="(e: any) => handleMaxInputRatioInput(e.target.value, v => updateConfigField('summarizeMaxInputRatio', v / 100))"
          />
          <span class="unit">%</span>
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.maxInputRatioHint') }}</p>
      </div>

      <div v-if="!standaloneContext || summarizeConfig.method !== 'notes'" class="form-group">
        <div class="prompt-label-row">
          <label>{{ t('components.settings.summarizeSettings.optionsSection.manualPrompt') }}</label>
          <button
            type="button"
            class="restore-default-btn"
            :disabled="!hasManualDefaultPrompt"
            @click="restorePromptToDefault('manual')"
          >{{ t('components.settings.summarizeSettings.optionsSection.restoreBuiltin') }}</button>
        </div>
        <textarea
          :value="summarizeConfig.summarizePrompt"
          rows="3"
          :placeholder="t('components.settings.summarizeSettings.optionsSection.manualPromptPlaceholder')"
          @input="(e: any) => updateConfigField('summarizePrompt', e.target.value)"
        ></textarea>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.manualPromptHint') }}</p>
      </div>

      <div class="form-group">
        <div class="prompt-label-row">
          <label>{{ t('components.settings.summarizeSettings.optionsSection.autoPrompt') }}</label>
          <button
            type="button"
            class="restore-default-btn"
            :disabled="!hasAutoDefaultPrompt"
            @click="restorePromptToDefault('auto')"
          >{{ t('components.settings.summarizeSettings.optionsSection.restoreBuiltin') }}</button>
        </div>
        <textarea
          :value="summarizeConfig.autoSummarizePrompt"
          rows="5"
          :placeholder="t('components.settings.summarizeSettings.optionsSection.autoPromptPlaceholder')"
          @input="(e: any) => updateConfigField('autoSummarizePrompt', e.target.value)"
        ></textarea>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.autoPromptHint') }}</p>
      </div>
    </div>
    
    <!-- 专用总结模型 -->
    <div v-if="!standaloneContext" class="section" data-search-anchor="summarize-model">
      <h5 class="section-title">
        <i class="codicon codicon-beaker"></i>
        {{ t('components.settings.summarizeSettings.modelSection.title') }}
      </h5>
      
      <div class="form-group">
        <CustomCheckbox
          :model-value="summarizeConfig.useSeparateModel"
          :label="t('components.settings.summarizeSettings.modelSection.useSeparate')"
          @update:model-value="(v: boolean) => updateConfigField('useSeparateModel', v)"
        />
        <p class="field-hint">
          {{ t('components.settings.summarizeSettings.modelSection.useSeparateHint') }}
        </p>
      </div>
      
      <div class="default-model-hint" v-if="!summarizeConfig.useSeparateModel">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.settings.summarizeSettings.modelSection.currentModelHint') }}</span>
      </div>
      
      <template v-if="summarizeConfig.useSeparateModel">
        <!-- 渠道选择 -->
        <div class="form-group">
          <label>{{ t('components.settings.summarizeSettings.modelSection.selectChannel') }}</label>
          <CustomSelect
            :model-value="summarizeConfig.summarizeChannelId"
            :options="enabledChannelOptions"
            :placeholder="t('components.settings.summarizeSettings.modelSection.selectChannelPlaceholder')"
            @update:model-value="updateChannelId"
          />
          <p class="field-hint">{{ t('components.settings.summarizeSettings.modelSection.selectChannelHint') }}</p>
        </div>
        
        <!-- 模型选择 -->
        <div class="form-group">
          <label>{{ t('components.settings.summarizeSettings.modelSection.selectModel') }}</label>
          <CustomSelect
            :model-value="summarizeConfig.summarizeModelId"
            :options="modelOptions"
            :disabled="!summarizeConfig.summarizeChannelId"
            :placeholder="t('components.settings.summarizeSettings.modelSection.selectModelPlaceholder')"
            @update:model-value="updateModelId"
          />
          <p class="field-hint">
            {{ t('components.settings.summarizeSettings.modelSection.selectModelHint') }}
          </p>
        </div>
        
        <!-- 选择状态提示 -->
        <div v-if="!summarizeConfig.summarizeChannelId || !summarizeConfig.summarizeModelId" class="warning-hint">
          <i class="codicon codicon-warning"></i>
          <span>{{ t('components.settings.summarizeSettings.modelSection.warningHint') }}</span>
        </div>
      </template>
    </div>
    
  </div>
</template>

<style scoped>
.summarize-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 功能说明 */
.feature-description {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: var(--gc-info-bg);
  border-radius: var(--gc-radius-lg);
}

.feature-description .codicon {
  flex-shrink: 0;
  color: var(--gc-link);
}

.feature-description p {
  margin: 0;
  font-size: 12px;
  color: var(--gc-text-primary);
  line-height: 1.5;
}

/* 分区 */
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--gc-surface-raised);
  border: 1px solid transparent;
  border-radius: var(--gc-radius-lg);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--gc-text-primary);
}

.section-title .codicon {
  font-size: 14px;
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--gc-text-muted);
  line-height: 1.5;
}

/* 徽章 */
.badge {
  padding: 2px 6px;
  font-size: 10px;
  font-weight: normal;
  border-radius: var(--gc-radius-md);
  margin-left: auto;
}

.badge.coming-soon {
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
}

/* 表单组 */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.form-group label {
  font-size: 12px;
  color: var(--gc-text-primary);
}

.prompt-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.restore-default-btn {
  padding: 2px 8px;
  font-size: 11px;
  color: var(--gc-link);
  background: transparent;
  border: 1px solid var(--gc-link);
  border-radius: var(--gc-radius-sm);
  cursor: pointer;
  line-height: 1.4;
  transition: opacity 0.15s, background-color 0.15s;
}

.restore-default-btn:hover:not(:disabled) {
  background: var(--gc-surface-hover);
}

.restore-default-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  border-color: var(--gc-text-disabled);
  color: var(--gc-text-disabled);
}

.form-group input[type="number"],
.form-group input[type="text"],
.form-group textarea {
  padding: 6px 10px;
  font-size: 13px;
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  outline: none;
  transition: border-color 0.15s;
}

/* 隐藏数字输入框的上下箭头 */
.form-group input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield; /* Firefox */
}

.form-group input[type="number"]::-webkit-outer-spin-button,
.form-group input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.form-group input[type="number"]:focus,
.form-group input[type="text"]:focus,
.form-group textarea:focus {
  border-color: var(--gc-focus-border);
}

.form-group textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--gc-text-muted);
}

/* 阈值输入 */
.threshold-input,
.rounds-input {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 120px;
}

.threshold-input input,
.rounds-input input {
  flex: 1;
  min-width: 0;
}

.unit {
  font-size: 12px;
  color: var(--gc-text-muted);
}

/* 默认模型提示 */
.default-model-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--gc-quote-bg);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  color: var(--gc-text-muted);
}

.default-model-hint .codicon {
  font-size: 14px;
  color: var(--gc-link);
}

/* 警告提示 */
.warning-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--gc-warning-bg);
  border: 1px solid var(--gc-warning-border);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  color: var(--gc-text-primary);
  margin-top: 8px;
}

.warning-hint .codicon {
  font-size: 14px;
  color: var(--gc-warning);
}

</style>
