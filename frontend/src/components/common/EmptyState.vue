<template>
  <div class="empty-state">
    <h3 class="empty-title">{{ title }}</h3>
    <p v-if="description" class="empty-description">{{ description }}</p>
    <button v-if="actionText" class="empty-action" @click="$emit('action')">
      {{ actionText }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  actionText?: string
}>()

defineEmits<{
  action: []
}>()
</script>

<style scoped>
/* 扁平化空状态 - 简洁设计 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  height: 100%;
  padding: var(--spacing-xl, 32px) var(--spacing-md, 16px);
  color: var(--gc-text-muted);
}

.empty-title {
  margin: 0 0 var(--spacing-sm, 8px) 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--gc-text-primary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.empty-description {
  margin: 0 0 var(--spacing-lg, 24px) 0;
  font-size: 13px;
  line-height: 1.5;
  max-width: 320px;
}

.empty-action {
  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--gc-surface-base);
  background-color: var(--gc-text-primary);
  border: none;
  border-radius: var(--radius-sm, 2px);
  cursor: pointer;
  transition: opacity var(--transition-fast, 0.1s);
}

.empty-action:hover {
  opacity: 0.85;
}
</style>