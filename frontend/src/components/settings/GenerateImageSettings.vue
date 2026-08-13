<script setup lang="ts">
/**
 * GenerateImageSettings - 图像生成工具设置面板
 * 配置图像生成 API 和默认参数
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { reactive, ref, onMounted, onUnmounted, computed } from 'vue'
import { CustomSelect, CustomCheckbox, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useDeferredNumberInput } from '@/composables/useDeferredNumberInput'
import type { ImageConfig } from '@/types'

const { t } = useI18n()

// 图像生成配置
const imageConfig = reactive<ImageConfig>({
  url: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  model: 'gemini-3-pro-image-preview',
  enableAspectRatio: false,
  defaultAspectRatio: '',
  enableImageSize: false,
  defaultImageSize: '',
  maxBatchTasks: 5,
  maxImagesPerTask: 1
})

// API Key 显示状态
const showApiKey = ref(false)

// 草稿模式：清空后不立即回填默认值；离开设置页时自动回填已保存值
// 保留原 parseInt 的整数语义：旧代码 parseInt(v) || 5 / || 1，输入 0 会归一化为默认值；
// 这里用 v >= 1 拦截 0/负数（模板 min="1"），避免 0 被直接持久化（批量任务数为 0 语义非法）
const {
  draft: maxBatchTasksDraft,
  handleInput: handleMaxBatchTasksInput,
  syncFromStored: syncMaxBatchTasksFromStored
} = useDeferredNumberInput(() => imageConfig.maxBatchTasks, v => Number.isInteger(v) && v >= 1)
const {
  draft: maxImagesPerTaskDraft,
  handleInput: handleMaxImagesPerTaskInput,
  syncFromStored: syncMaxImagesPerTaskFromStored
} = useDeferredNumberInput(() => imageConfig.maxImagesPerTask, v => Number.isInteger(v) && v >= 1)

// 宽高比选项
const aspectRatioOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('components.settings.generateImageSettings.aspectRatio.options.auto'), description: t('components.settings.generateImageSettings.aspectRatio.options.auto') },
  { value: '1:1', label: '1:1', description: t('components.settings.generateImageSettings.aspectRatio.options.square') },
  { value: '3:2', label: '3:2', description: t('components.settings.generateImageSettings.aspectRatio.options.landscape') },
  { value: '2:3', label: '2:3', description: t('components.settings.generateImageSettings.aspectRatio.options.portrait') },
  { value: '3:4', label: '3:4', description: t('components.settings.generateImageSettings.aspectRatio.options.portrait') },
  { value: '4:3', label: '4:3', description: t('components.settings.generateImageSettings.aspectRatio.options.landscape') },
  { value: '4:5', label: '4:5', description: t('components.settings.generateImageSettings.aspectRatio.options.portrait') },
  { value: '5:4', label: '5:4', description: t('components.settings.generateImageSettings.aspectRatio.options.landscape') },
  { value: '9:16', label: '9:16', description: t('components.settings.generateImageSettings.aspectRatio.options.mobilePortrait') },
  { value: '16:9', label: '16:9', description: t('components.settings.generateImageSettings.aspectRatio.options.widescreen') },
  { value: '21:9', label: '21:9', description: t('components.settings.generateImageSettings.aspectRatio.options.ultrawide') }
])

// 图片尺寸选项
const imageSizeOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('components.settings.generateImageSettings.imageSize.options.auto'), description: t('components.settings.generateImageSettings.imageSize.options.auto') },
  { value: '1K', label: '1K', description: '1024px' },
  { value: '2K', label: '2K', description: '2048px' },
  { value: '4K', label: '4K', description: '4096px' }
])

// 加载配置
async function loadConfig() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getGenerateImageConfig, {})
    if (response) {
      Object.assign(imageConfig, response)
      syncMaxBatchTasksFromStored()
      syncMaxImagesPerTaskFromStored()
    }
  } catch (error) {
    console.error('Failed to load generate image config:', error)
  }
}

// 更新配置字段（即时更新本地值 + 防抖保存）
// @input 每按键触发：统一 400ms 防抖提交，避免每按键全量写配置
let configSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null

async function updateConfigField<K extends keyof ImageConfig>(field: K, value: ImageConfig[K] | undefined) {
  // 先更新本地值（即时反馈）
  imageConfig[field] = value as ImageConfig[K]
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
    await sendToExtension(MESSAGE_NAMES.updateGenerateImageConfig, {
      config: { ...imageConfig }
    })
  } catch (error) {
    console.error('Failed to save generate image config:', error)
  }
}

// 初始化
onMounted(async () => {
  await loadConfig()
})

onUnmounted(() => {
  // 卸载时若有待触发的防抖保存，立即 flush 一次（写配置不依赖组件存活），避免最后一次编辑丢失
  if (configSaveDebounceTimer) {
    clearTimeout(configSaveDebounceTimer)
    configSaveDebounceTimer = null
    void persistConfig()
  }
})
</script>

<template>
  <div class="generate-image-settings">
    <!-- 功能说明 -->
    <div class="feature-description">
      <i class="codicon codicon-image"></i>
      <p>{{ t('components.settings.generateImageSettings.description') }}</p>
    </div>
    
    <!-- API 配置 -->
    <div class="section" data-search-anchor="image-api-config">
      <h5 class="section-title">
        <i class="codicon codicon-plug"></i>
        {{ t('components.settings.generateImageSettings.api.title') }}
      </h5>
      
      <div class="form-group">
        <label>{{ t('components.settings.generateImageSettings.api.url') }}</label>
        <input
          type="text"
          :value="imageConfig.url"
          :placeholder="t('components.settings.generateImageSettings.api.urlPlaceholder')"
          @input="(e: any) => updateConfigField('url', e.target.value)"
        />
        <p class="field-hint">{{ t('components.settings.generateImageSettings.api.urlHint') }}</p>
      </div>
      
      <div class="form-group">
        <label>{{ t('components.settings.generateImageSettings.api.apiKey') }}</label>
        <div class="input-with-action">
          <input
            :type="showApiKey ? 'text' : 'password'"
            :value="imageConfig.apiKey"
            :placeholder="t('components.settings.generateImageSettings.api.apiKeyPlaceholder')"
            @input="(e: any) => updateConfigField('apiKey', e.target.value)"
          />
          <button
            class="input-action-btn"
            :title="showApiKey ? t('components.settings.generateImageSettings.api.hide') : t('components.settings.generateImageSettings.api.show')"
            @click="showApiKey = !showApiKey"
          >
            <i :class="['codicon', showApiKey ? 'codicon-eye-closed' : 'codicon-eye']"></i>
          </button>
        </div>
        <p class="field-hint">{{ t('components.settings.generateImageSettings.api.apiKeyHint') }}</p>
      </div>
      
      <div class="form-group">
        <label>{{ t('components.settings.generateImageSettings.api.model') }}</label>
        <input
          type="text"
          :value="imageConfig.model"
          :placeholder="t('components.settings.generateImageSettings.api.modelPlaceholder')"
          @input="(e: any) => updateConfigField('model', e.target.value)"
        />
        <p class="field-hint">{{ t('components.settings.generateImageSettings.api.modelHint') }}</p>
      </div>
    </div>
    
    <!-- 宽高比参数 -->
    <div class="section" data-search-anchor="aspect-ratio">
      <h5 class="section-title">
        <i class="codicon codicon-symbol-ruler"></i>
        {{ t('components.settings.generateImageSettings.aspectRatio.title') }}
      </h5>
      
      <CustomCheckbox
        :model-value="imageConfig.enableAspectRatio"
        :label="t('components.settings.generateImageSettings.aspectRatio.enable')"
        @update:model-value="(v: boolean) => updateConfigField('enableAspectRatio', v)"
      />
      
      <div class="form-group" :class="{ disabled: !imageConfig.enableAspectRatio }">
        <label>{{ t('components.settings.generateImageSettings.aspectRatio.fixedRatio') }}</label>
        <CustomSelect
          :model-value="imageConfig.defaultAspectRatio || ''"
          :options="aspectRatioOptions"
          :placeholder="t('components.settings.generateImageSettings.aspectRatio.placeholder')"
          :disabled="!imageConfig.enableAspectRatio"
          @update:model-value="(v: string) => updateConfigField('defaultAspectRatio', v || undefined)"
        />
        <p class="field-hint">
          <template v-if="!imageConfig.enableAspectRatio">
            {{ t('components.settings.generateImageSettings.aspectRatio.hints.disabled') }}
          </template>
          <template v-else-if="imageConfig.defaultAspectRatio">
            {{ t('components.settings.generateImageSettings.aspectRatio.hints.fixed', { ratio: imageConfig.defaultAspectRatio }) }}
          </template>
          <template v-else>
            {{ t('components.settings.generateImageSettings.aspectRatio.hints.flexible') }}
          </template>
        </p>
      </div>
    </div>
    
    <!-- 图片尺寸参数 -->
    <div class="section" data-search-anchor="image-size">
      <h5 class="section-title">
        <i class="codicon codicon-screen-full"></i>
        {{ t('components.settings.generateImageSettings.imageSize.title') }}
      </h5>
      
      <CustomCheckbox
        :model-value="imageConfig.enableImageSize"
        :label="t('components.settings.generateImageSettings.imageSize.enable')"
        @update:model-value="(v: boolean) => updateConfigField('enableImageSize', v)"
      />
      
      <div class="form-group" :class="{ disabled: !imageConfig.enableImageSize }">
        <label>{{ t('components.settings.generateImageSettings.imageSize.fixedSize') }}</label>
        <CustomSelect
          :model-value="imageConfig.defaultImageSize || ''"
          :options="imageSizeOptions"
          :placeholder="t('components.settings.generateImageSettings.imageSize.placeholder')"
          :disabled="!imageConfig.enableImageSize"
          @update:model-value="(v: string) => updateConfigField('defaultImageSize', v || undefined)"
        />
        <p class="field-hint">
          <template v-if="!imageConfig.enableImageSize">
            {{ t('components.settings.generateImageSettings.imageSize.hints.disabled') }}
          </template>
          <template v-else-if="imageConfig.defaultImageSize">
            {{ t('components.settings.generateImageSettings.imageSize.hints.fixed', { size: imageConfig.defaultImageSize }) }}
          </template>
          <template v-else>
            {{ t('components.settings.generateImageSettings.imageSize.hints.flexible') }}
          </template>
        </p>
      </div>
    </div>
    
    <!-- 批量生成限制 -->
    <div class="section" data-search-anchor="batch-limits">
      <h5 class="section-title">
        <i class="codicon codicon-layers"></i>
        {{ t('components.settings.generateImageSettings.batch.title') }}
      </h5>
      
      <div class="form-group">
        <label>{{ t('components.settings.generateImageSettings.batch.maxTasks') }}</label>
        <input
          type="number"
          :value="maxBatchTasksDraft"
          min="1"
          max="20"
          @input="(e: any) => handleMaxBatchTasksInput(e.target.value, v => updateConfigField('maxBatchTasks', v))"
        />
        <p class="field-hint">{{ t('components.settings.generateImageSettings.batch.maxTasksHint') }}</p>
      </div>
      
      <div class="form-group">
        <label>{{ t('components.settings.generateImageSettings.batch.maxImagesPerTask') }}</label>
        <input
          type="number"
          :value="maxImagesPerTaskDraft"
          min="1"
          max="10"
          @input="(e: any) => handleMaxImagesPerTaskInput(e.target.value, v => updateConfigField('maxImagesPerTask', v))"
        />
        <p class="field-hint">{{ t('components.settings.generateImageSettings.batch.maxImagesPerTaskHint') }}</p>
      </div>
      
      <div class="limits-summary">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.settings.generateImageSettings.batch.summary', { maxTasks: imageConfig.maxBatchTasks, maxImages: imageConfig.maxImagesPerTask }) }}</span>
      </div>
    </div>
    
    <!-- 使用说明 -->
    <div class="section" data-search-anchor="image-usage">
      <h5 class="section-title">
        <i class="codicon codicon-question"></i>
        {{ t('components.settings.generateImageSettings.usage.title') }}
      </h5>
      
      <div class="usage-notes">
        <div class="note-item">
          <span class="note-number">1</span>
          <span class="note-text">{{ t('components.settings.generateImageSettings.usage.step1') }}</span>
        </div>
        <div class="note-item">
          <span class="note-number">2</span>
          <span class="note-text">{{ t('components.settings.generateImageSettings.usage.step2') }}</span>
        </div>
        <div class="note-item">
          <span class="note-number">3</span>
          <span class="note-text">{{ t('components.settings.generateImageSettings.usage.step3') }}</span>
        </div>
        <div class="note-item">
          <span class="note-number">4</span>
          <span class="note-text">{{ t('components.settings.generateImageSettings.usage.step4') }}</span>
        </div>
      </div>
      
      <div class="warning-hint" v-if="!imageConfig.apiKey">
        <i class="codicon codicon-warning"></i>
        <span>{{ t('components.settings.generateImageSettings.usage.warning') }}</span>
      </div>
    </div>
    
  </div>
</template>

<style scoped>
.generate-image-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 功能说明 */
.feature-description {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
  border-radius: 0 4px 4px 0;
}

.feature-description .codicon {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--vscode-textLink-foreground);
}

.feature-description p {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.5;
}

/* 分区 */
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.section-title .codicon {
  font-size: 14px;
}

/* 表单组 */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.form-group input[type="text"],
.form-group input[type="password"] {
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.form-group input:focus {
  border-color: var(--vscode-focusBorder);
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 带操作按钮的输入框 */
.input-with-action {
  display: flex;
  gap: 4px;
}

.input-with-action input {
  flex: 1;
}

.input-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  padding: 0;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.input-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* 使用说明 */
.usage-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.note-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.note-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: 50%;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}

.note-text {
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 20px;
}

/* 警告提示 */
.warning-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-top: 8px;
}

.warning-hint .codicon {
  font-size: 14px;
  color: var(--vscode-list-warningForeground);
}

/* 数字输入框 */
.form-group input[type="number"] {
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
  width: 100px;
  /* 隐藏右侧上下箭头 */
  appearance: textfield;
  -moz-appearance: textfield;
}

/* 隐藏右侧上下箭头 - Chrome, Safari, Edge, Opera */
.form-group input[type="number"]::-webkit-outer-spin-button,
.form-group input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.form-group input[type="number"]:focus {
  border-color: var(--vscode-focusBorder);
}

/* 限制摘要 */
.limits-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-top: 4px;
}

.limits-summary .codicon {
  font-size: 14px;
  color: var(--vscode-textLink-foreground);
}

/* 禁用状态 */
.form-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>