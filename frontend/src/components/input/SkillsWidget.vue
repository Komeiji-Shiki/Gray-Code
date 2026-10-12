<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, ref, watch } from 'vue'
import { IconButton, Tooltip, CustomScrollbar } from '../common'
import { useI18n } from '../../i18n'
import { showNotification } from '../../utils/vscode'
import { useChatStore } from '../../stores'
import type { SkillItem } from '../../services/skills'
import {
  checkSkillsExistence,
  getSkillsDirectory,
  listSkills,
  openDirectory,
  refreshSkills,
  removeSkillConfig,
  setSkillEnabled
} from '../../services/skills'

const { t } = useI18n()
const chatStore = useChatStore()

const skills = ref<SkillItem[]>([])
const showSkillsPanel = ref(false)
const skillsButtonRef = ref<HTMLButtonElement>()
const skillsPanelRef = ref<HTMLElement>()
const skillsPanelId = `gc-input-skills-${getCurrentInstance()?.uid ?? 0}`

const loadingCount = ref(0)
const isLoadingSkills = computed(() => loadingCount.value > 0)

async function withLoading<T>(fn: () => Promise<T>): Promise<T> {
  loadingCount.value++
  try {
    return await fn()
  } finally {
    loadingCount.value--
  }
}

async function loadSkills() {
  try {
    // Skill 配置是全局的，不传 conversationId，始终读取全局配置。
    skills.value = await listSkills()
  } catch (error) {
    console.error('Failed to load skills:', error)
    skills.value = []
  }
}

const refreshButtonIcon = computed(() =>
  isLoadingSkills.value
    ? 'codicon-refresh codicon-modifier-spin'
    : 'codicon-refresh'
)

async function refreshSkillsExistence() {
  if (skills.value.length === 0) return

  try {
    const result = await checkSkillsExistence(skills.value.map(s => s.id))
    if (result?.skills) {
      for (const skillResult of result.skills) {
        const skill = skills.value.find(s => s.id === skillResult.id)
        if (skill) skill.exists = skillResult.exists
      }
    }
  } catch (error) {
    console.error('Failed to check skills existence:', error)
  }
}

async function handleToggleSkillEnabled(id: string, enabled: boolean) {
  try {
    // Skill 启用/禁用是全局操作，不传 conversationId。
    // 原先传了 conversationId 导致走对话级分支，SkillsManager 全局状态和
    // read_skill 工具声明都不会更新，AI 看到的 Skill 列表锁定在旧值。
    await setSkillEnabled(id, enabled)
    const skill = skills.value.find(s => s.id === id)
    if (skill) skill.enabled = enabled
  } catch (error: any) {
    console.error('Failed to toggle skill enabled:', error)
    await showNotification(t('components.input.skillsPanel.toggleFailed'), 'error')
  }
}

async function handleRemoveSkillConfig(id: string) {
  try {
    // Skill 配置是全局的，不传 conversationId。
    await removeSkillConfig(id)
    skills.value = skills.value.filter(s => s.id !== id)
  } catch (error: any) {
    console.error('Failed to remove skill config:', error)
    await showNotification(t('components.input.skillsPanel.removeFailed'), 'error')
  }
}

async function handleOpenSkillsDirectory() {
  try {
    const result = await getSkillsDirectory()
    if (result?.path) {
      await openDirectory(result.path)
    }
  } catch (error: any) {
    console.error('Failed to open skills directory:', error)
    await showNotification(t('components.input.skillsPanel.openDirectoryFailed'), 'error')
  }
}

async function handleRefreshSkills() {
  if (isLoadingSkills.value) return

  await withLoading(async () => {
    try {
      await refreshSkills()
      await loadSkills()
      await refreshSkillsExistence()
    } catch (error: any) {
      console.error('Failed to refresh skills:', error)
    }
  })
}

async function toggleSkillsPanel() {
  showSkillsPanel.value = !showSkillsPanel.value
  if (showSkillsPanel.value) {
    await nextTick(() => skillsPanelRef.value?.focus())
    await withLoading(async () => {
      await loadSkills()
      await refreshSkillsExistence()
    })
  }
}

const enabledSkillsCount = computed(() => skills.value.filter(s => s.enabled && s.exists !== false).length)
const skillsButtonLabel = computed(() => t('desktop.inputUi.skillsButton', { count: enabledSkillsCount.value }))

function closeSkillsPanel() {
  showSkillsPanel.value = false
  skillsButtonRef.value?.focus()
}

onMounted(() => {
  void withLoading(loadSkills)
})

watch(() => chatStore.currentConversationId, async () => {
  await withLoading(loadSkills)
  if (showSkillsPanel.value) {
    await refreshSkillsExistence()
  }
})
</script>

<template>
  <Tooltip :content="skillsButtonLabel" placement="top">
    <button
      ref="skillsButtonRef"
      type="button"
      :class="{ 'has-skills': enabledSkillsCount > 0 }"
      class="gc-button gc-button--ghost skills-button"
      :title="skillsButtonLabel"
      :aria-label="skillsButtonLabel"
      :aria-expanded="showSkillsPanel"
      :aria-controls="showSkillsPanel ? skillsPanelId : undefined"
      @click="toggleSkillsPanel"
    >
      <i class="codicon codicon-lightbulb" aria-hidden="true"></i>
      <span>{{ enabledSkillsCount > 0 ? t('desktop.inputUi.skillsCount', { count: enabledSkillsCount }) : t('desktop.inputUi.skills') }}</span>
    </button>
  </Tooltip>

  <div
    v-if="showSkillsPanel"
    :id="skillsPanelId"
    ref="skillsPanelRef"
    class="skills-panel"
    role="region"
    tabindex="-1"
    :aria-label="t('components.input.skillsPanel.title')"
    @keydown.esc.stop.prevent="closeSkillsPanel"
  >
    <div class="skills-header">
      <span class="skills-title">
        <i class="codicon codicon-lightbulb" aria-hidden="true"></i>
        {{ t('components.input.skillsPanel.title') }}
      </span>
      <div class="skills-header-actions">
        <IconButton
          :icon="refreshButtonIcon"
          size="small"
          :disabled="isLoadingSkills"
          @click="handleRefreshSkills"
          :tooltip="t('components.input.skillsPanel.refresh')"
          :aria-label="t('components.input.skillsPanel.refresh')"
        />
        <IconButton
          icon="codicon-folder-opened"
          size="small"
          @click="handleOpenSkillsDirectory"
          :tooltip="t('components.input.skillsPanel.openDirectory')"
          :aria-label="t('components.input.skillsPanel.openDirectory')"
        />
        <IconButton
          icon="codicon-close"
          size="small"
          :tooltip="t('desktop.inputUi.closeSkills')"
          :aria-label="t('desktop.inputUi.closeSkills')"
          @click="closeSkillsPanel"
        />
      </div>
    </div>
    <div class="skills-description">
      {{ t('components.input.skillsPanel.description') }}
    </div>
    <CustomScrollbar class="skills-content" :maxHeight="200">
      <div v-if="isLoadingSkills" class="skills-loading">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
        <span>{{ t('components.input.skillsPanel.loading') }}</span>
      </div>
      <div v-else-if="skills.length === 0" class="skills-empty">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.input.skillsPanel.empty') }}</span>
      </div>
      <div v-else class="skills-list">
        <div
          v-for="skill in skills"
          :key="skill.id"
          class="skill-item"
          :class="{ disabled: !skill.enabled, 'not-exists': skill.exists === false }"
        >
          <label class="skill-checkbox-wrapper" :title="t('desktop.inputUi.enableSkill', { name: skill.name })">
            <input
              type="checkbox"
              :checked="skill.enabled"
              :aria-label="t('desktop.inputUi.enableSkill', { name: skill.name })"
              @change="handleToggleSkillEnabled(skill.id, !skill.enabled)"
              :disabled="skill.exists === false"
            />
            <span class="skill-checkbox-custom"></span>
          </label>
          <div class="skill-info">
            <i :class="['codicon', skill.exists === false ? 'codicon-warning' : 'codicon-lightbulb']" aria-hidden="true"></i>
            <span class="skill-name" :title="skill.description">{{ skill.name }}</span>
            <span v-if="skill.exists === false" class="skill-not-exists-hint">{{ t('components.input.skillsPanel.notExists') }}</span>
          </div>
          <div class="skill-actions">
            <IconButton
              v-if="skill.exists === false"
              icon="codicon-close"
              size="small"
              @click="handleRemoveSkillConfig(skill.id)"
              :tooltip="t('desktop.inputUi.removeSkill', { name: skill.name })"
              :aria-label="t('desktop.inputUi.removeSkill', { name: skill.name })"
            />
          </div>
        </div>
      </div>
    </CustomScrollbar>
    <div class="skills-footer">
      <div class="skills-hint">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.input.skillsPanel.hint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skills-button {
  min-height: var(--gc-control-height-sm);
  padding: 0 var(--gc-space-1);
  font-size: var(--gc-font-size-caption);
  white-space: nowrap;
}

.skills-button .codicon {
  font-size: 16px;
}

.skills-button.has-skills .codicon {
  color: var(--gc-chart-yellow);
}

.skills-panel {
  position: absolute;
  bottom: 100%;
  left: 8px;
  right: 8px;
  margin-bottom: 8px;
  background: var(--gc-surface-raised);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  box-shadow: var(--gc-shadow-sm);
  z-index: 100;
  max-height: 300px;
  display: flex;
  flex-direction: column;
}

.skills-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--gc-border-subtle);
}

.skills-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.skills-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
}

.skills-title .codicon {
  color: var(--gc-chart-yellow);
}

.skills-description {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--gc-text-muted);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.skills-content {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.skills-loading,
.skills-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--gc-text-muted);
  font-size: 12px;
}

.skills-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--gc-surface-base);
  border-radius: var(--gc-radius-sm);
  transition: background-color 0.15s;
}

.skill-item:hover {
  background: var(--gc-surface-hover);
}

.skill-item.disabled {
  opacity: 0.6;
}

.skill-item.not-exists {
  border: 1px dashed var(--gc-warning);
}

.skill-item.not-exists .codicon-warning {
  color: var(--gc-warning);
}

.skill-checkbox-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.skill-checkbox-wrapper input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.skill-checkbox-custom {
  width: 14px;
  height: 14px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-xs);
  background: var(--gc-surface-input);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.skill-checkbox-wrapper input:checked + .skill-checkbox-custom {
  background: var(--gc-badge-bg);
  border-color: var(--gc-badge-bg);
}

.skill-checkbox-wrapper input:focus-visible + .skill-checkbox-custom {
  outline: 2px solid var(--gc-focus-border);
  outline-offset: 2px;
}

.skill-checkbox-wrapper input:checked + .skill-checkbox-custom::after {
  content: '';
  width: 4px;
  height: 8px;
  border: solid var(--gc-text-primary);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
  margin-bottom: 2px;
}

.skill-checkbox-wrapper input:disabled + .skill-checkbox-custom {
  opacity: 0.5;
  cursor: not-allowed;
}

.skill-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.skill-info .codicon-lightbulb {
  color: var(--gc-chart-yellow);
  flex-shrink: 0;
}

.skill-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-not-exists-hint {
  font-size: 10px;
  color: var(--gc-warning);
  padding: 1px 4px;
  background: var(--gc-warning-bg);
  border-radius: var(--gc-radius-xs);
  flex-shrink: 0;
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.skills-footer {
  padding: 6px 10px;
  border-top: 1px solid var(--gc-border-subtle);
}

.skills-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--gc-text-muted);
}

.skills-hint .codicon {
  font-size: 12px;
}

:deep(.codicon-refresh.codicon-modifier-spin) {
  /* codicon.css 只对部分 icon 默认开启 spin，这里补齐 refresh */
  animation: codicon-spin 1.5s steps(30) infinite;
}

@media (prefers-reduced-motion: reduce) {
  :deep(.codicon-refresh.codicon-modifier-spin) {
    animation: none;
  }
}
</style>
