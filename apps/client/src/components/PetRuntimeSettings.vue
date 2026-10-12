<script setup lang="ts">
import { ref } from 'vue';
import type { PetRuntime } from '@graycode/contracts';
import { shellText } from '../i18n';
import playerNotices from '../../public/pets-notices.txt?raw';

defineProps<{ runtime?: PetRuntime; disabled?: boolean; required?: boolean; stagedFileName?: string }>();
const emit = defineEmits<{ select: [file: File]; remove: [] }>();
const fileInput = ref<HTMLInputElement>();

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('select', file);
}
</script>
<template>
  <section class="pet-runtime">
    <h3>{{ shellText('petRuntimeTitle') }}</h3>
    <p v-if="required">{{ shellText('petRuntimeRequired') }}</p>
    <p>{{ shellText('petRuntimeHelp') }}</p>
    <a href="https://www.live2d.com/download/cubism-sdk/download-web/" target="_blank" rel="noreferrer">
      {{ shellText('petOfficialSdk') }}
    </a>
    <p v-if="runtime">{{ runtime.name }} · {{ (runtime.bytes / 1024 / 1024).toFixed(2) }} MiB</p>
    <p v-else>{{ stagedFileName || shellText('petRuntimeMissing') }}</p>
    <button class="file-button" type="button" :disabled="disabled" @click="fileInput?.click()">
      {{ shellText(required ? 'petSelectRuntime' : 'petImportRuntime') }}
    </button>
    <input ref="fileInput" type="file" accept=".js" :disabled="disabled" @change="selectFile">
    <button v-if="runtime" type="button" :disabled="disabled" @click="emit('remove')">{{ shellText('petRemoveRuntime') }}</button>
    <details v-if="!required"><summary>{{ shellText('petPlayerLicenses') }}</summary><pre>{{ playerNotices }}</pre></details>
  </section>
</template>
<style scoped>
.pet-runtime { min-width: 0; }
h3 { margin: 0; font-size: 14px; font-weight: 600; }
p, pre { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
a { color: var(--gc-accent); font-size: 12px; }
button, .file-button {
  display: inline-flex;
  padding: 7px 9px;
  margin: 0 8px 8px 0;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:disabled { opacity: .5; cursor: default; }
input { display: none; }
details { margin-top: 12px; }
summary { cursor: pointer; font-size: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
