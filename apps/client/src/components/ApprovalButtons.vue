<script setup lang="ts">
import type { ApprovalChoice, ApprovalDecision } from '@graycode/contracts';
defineProps<{ choices?: ApprovalChoice[]; disabled?: boolean; allowLabel?: string; denyLabel?: string }>();
const emit = defineEmits<{ resolve: [decision: ApprovalDecision] }>();
</script>
<template>
  <div class="approval-buttons">
    <template v-if="choices?.length"><button v-for="choice in choices" :key="choice.id" type="button" :disabled="disabled"
      @click="emit('resolve', { accepted: choice.kind.startsWith('allow'), choiceId: choice.id })">{{ choice.label }}</button></template>
    <template v-else><button type="button" :disabled="disabled" @click="emit('resolve', { accepted: false })">{{ denyLabel || '拒绝' }}</button>
      <button type="button" :disabled="disabled" @click="emit('resolve', { accepted: true })">{{ allowLabel || '允许执行' }}</button></template>
  </div>
</template>
<style scoped>
.approval-buttons{display:flex;gap:7px;flex-wrap:wrap}.approval-buttons button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:0;padding:6px 9px;text-align:left;cursor:pointer}.approval-buttons button:disabled{opacity:.5;cursor:default}
</style>
