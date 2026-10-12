<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CompanionView } from '@graycode/contracts';
import { rpc } from '../api';
import { shellText as t } from '../i18n';

const props = defineProps<{
  conversationId?: string;
  petResourceId?: string;
  vocabulary?: CompanionView['petVocabulary'];
  metadataToken?: string;
  defaultsRevision: number | null;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  synced: [view: CompanionView];
  busy: [value: boolean];
}>();
const syncing = ref(false);
const syncedResourceId = ref<string>();
const error = ref('');
const sameResource = computed(() => props.petResourceId === props.vocabulary?.resourceId);
const synced = computed(() => !!syncedResourceId.value && syncedResourceId.value === props.petResourceId);

watch(() => props.petResourceId, () => {
  error.value = '';
  syncedResourceId.value = undefined;
});

async function sync() {
  syncing.value = true;
  emit('busy', true);
  error.value = '';
  try {
    // 同步只更新已保存绑定，未保存的表单继续留在父组件中。
    const result = await rpc('companion.save', {
      action: 'syncPetVocabulary',
      conversationId: props.conversationId,
      metadataToken: props.metadataToken,
      defaultsRevision: props.defaultsRevision,
    });
    if (result.view) {
      emit('synced', result.view);
      syncedResourceId.value = result.view.petVocabulary?.resourceId;
    }
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    syncing.value = false;
    emit('busy', false);
  }
}
</script>

<template>
  <section v-if="vocabulary?.updated || synced" class="companion-vocabulary" aria-live="polite">
    <template v-if="vocabulary?.updated">
      <p class="companion-vocabulary-title">{{ t('companionVocabularyUpdated') }}</p>
      <p>{{ t(conversationId ? 'companionVocabularySyncHint' : 'companionVocabularyDefaultSyncHint') }}</p>
      <p v-if="!sameResource">{{ t('companionVocabularySaveBinding') }}</p>
      <button type="button" :disabled="disabled || syncing || !sameResource" @click="sync">
        {{ t(syncing ? 'companionVocabularySyncing' : 'companionVocabularySync') }}
      </button>
    </template>
    <p v-else role="status">{{ t('companionVocabularySynced') }}</p>
    <p v-if="error" class="companion-vocabulary-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.companion-vocabulary {
  padding: 12px 14px;
  margin-bottom: 17px;
  background: var(--gc-surface-raised);
  color: var(--gc-text-muted);
  font-size: 12px;
  line-height: 1.7;
}
p { margin: 0 0 8px; }
p:last-child { margin-bottom: 0; }
.companion-vocabulary-title { color: var(--gc-text-primary); font-weight: 600; }
.companion-vocabulary-error { color: var(--gc-danger); margin-top: 8px; }
button {
  padding: 7px 10px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  cursor: pointer;
}
button:disabled { cursor: default; opacity: .6; }
</style>
