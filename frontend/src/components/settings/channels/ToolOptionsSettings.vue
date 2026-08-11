<script setup lang="ts">
/**
 * 工具配置面板
 *
 * 各工具的渠道级配置项
 */

import { computed } from 'vue'
import { useI18n } from '../../../i18n'

const { t } = useI18n()

interface CropImageToolOptions {
  useNormalizedCoordinates?: boolean
}

interface ToolOptions {
  cropImage?: CropImageToolOptions
}

const props = defineProps<{
  /** 工具配置 */
  toolOptions: ToolOptions
}>()

const emit = defineEmits<{
  (e: 'update:config', config: ToolOptions): void
}>()

// 裁切图片工具配置
const cropImageOptions = computed<CropImageToolOptions>(() => {
  return props.toolOptions?.cropImage || { useNormalizedCoordinates: true }
})

// 更新裁切图片配置
function updateCropImageOption<K extends keyof CropImageToolOptions>(
  key: K,
  value: CropImageToolOptions[K]
) {
  emit('update:config', {
    ...props.toolOptions,
    cropImage: {
      ...cropImageOptions.value,
      [key]: value
    }
  })
}
</script>

<template>
  <div class="tool-options-settings">
    <!-- 裁切图片工具 -->
    <div class="tool-section">
      <div class="tool-header">
        <span class="codicon codicon-selection"></span>
        <span class="tool-name">{{ t('components.channels.toolOptions.cropImage.title') }}</span>
      </div>
      
      <div class="tool-content">
        <div class="option-item">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="cropImageOptions.useNormalizedCoordinates ?? true"
              @change="(e: any) => updateCropImageOption('useNormalizedCoordinates', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.toolOptions.cropImage.useNormalizedCoords') }}</span>
          </label>
          
          <div class="option-description">
            <div class="desc-item">
              <span class="codicon codicon-check"></span>
              <span class="desc-text"><strong>{{ t('components.channels.toolOptions.cropImage.enabledTitle') }}</strong>：使用 0-1000 归一化坐标系统</span>
            </div>
            <ul class="coord-examples">
              <li><code>(0, 0)</code> {{ t('components.channels.toolOptions.cropImage.coordTopLeft') }}</li>
              <li><code>(1000, 1000)</code> {{ t('components.channels.toolOptions.cropImage.coordBottomRight') }}</li>
              <li><code>(500, 500)</code> {{ t('components.channels.toolOptions.cropImage.coordCenter') }}</li>
            </ul>
            <div class="desc-note">
              <span class="codicon codicon-lightbulb"></span>
              <span>{{ t('components.channels.toolOptions.cropImage.enabledNote') }}</span>
            </div>
          </div>
          
          <div class="option-description alt">
            <div class="desc-item">
              <span class="codicon codicon-close"></span>
              <span class="desc-text"><strong>{{ t('components.channels.toolOptions.cropImage.disabledTitle') }}</strong>：使用像素坐标</span>
            </div>
            <div class="desc-note">
              <span class="codicon codicon-info"></span>
              <span>{{ t('components.channels.toolOptions.cropImage.disabledNote') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-options-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 工具分组 */
.tool-section {
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tool-header .codicon {
  font-size: 14px;
  color: var(--vscode-charts-blue, #3794ff);
}

.tool-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.tool-content {
  padding: 12px;
}

/* 选项项 */
.option-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 自定义勾选框 */
.custom-checkbox {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 12px;
  font-weight: normal;
  position: relative;
  padding-left: 24px;
  user-select: none;
}

.custom-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.custom-checkbox .checkmark {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 16px;
  width: 16px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  transition: all 0.15s;
}

.custom-checkbox:hover .checkmark {
  border-color: var(--vscode-focusBorder);
}

.custom-checkbox input:checked ~ .checkmark {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.custom-checkbox .checkmark::after {
  content: '';
  position: absolute;
  display: none;
  left: 5px;
  top: 2px;
  width: 4px;
  height: 8px;
  border: solid var(--vscode-button-foreground);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.custom-checkbox input:checked ~ .checkmark::after {
  display: block;
}

.checkbox-text {
  margin-left: 4px;
  color: var(--vscode-foreground);
}

/* 选项描述 */
.option-description {
  margin-left: 24px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  font-size: 11px;
}

.option-description.alt {
  background: rgba(255, 255, 255, 0.03);
}

.desc-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-foreground);
}

.desc-item .codicon-check {
  color: var(--vscode-charts-green, #89d185);
}

.desc-item .codicon-close {
  color: var(--vscode-charts-orange, #cca700);
}

.desc-text {
  color: var(--vscode-foreground);
}

.coord-examples {
  margin: 6px 0 6px 20px;
  padding: 0;
  list-style: none;
  color: var(--vscode-descriptionForeground);
}

.coord-examples li {
  padding: 2px 0;
}

.coord-examples code {
  padding: 1px 4px;
  background: var(--gc-surface-editor-bg);
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family);
  font-size: 10px;
}

.desc-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: var(--vscode-descriptionForeground);
}

.desc-note .codicon {
  font-size: 12px;
}

.desc-note .codicon-lightbulb {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.desc-note .codicon-info {
  color: var(--vscode-charts-blue, #3794ff);
}
</style>