<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { PetResource } from '@graycode/contracts';
import { rpc } from '../api';
import { shellText } from '../i18n';

const props = defineProps<{ resource: PetResource; disabled?: boolean }>();
const emit = defineEmits<{ saved: [resource: PetResource]; dirty: [value: boolean]; failed: [message: string] }>();
const description = ref('');
const actionDescriptions = reactive<Record<string, string>>({});
const expressionDescriptions = reactive<Record<string, string>>({});
const hitMappings = reactive<Record<string, string>>({});
const baseline = ref('');
const saving = ref(false);
const serialized = () => JSON.stringify({ description: description.value, actionDescriptions, expressionDescriptions, hitMappings });
const dirty = computed(() => !!baseline.value && serialized() !== baseline.value);

function reset() {
  description.value = props.resource.description;
  for (const values of [actionDescriptions, expressionDescriptions, hitMappings]) {
    for (const key of Object.keys(values)) delete values[key];
  }
  for (const action of props.resource.actions) actionDescriptions[action.id] = action.description ?? '';
  for (const expression of props.resource.expressions) expressionDescriptions[expression.id] = expression.description ?? '';
  for (const area of props.resource.hitAreas ?? []) hitMappings[area.id] = area.motion ?? '';
  baseline.value = serialized();
}
async function save() {
  saving.value = true;
  try {
    const resource = await rpc('pets.resource.annotate', {
      id: props.resource.id, description: description.value,
      actions: props.resource.actions.map(action => ({ id: action.id, description: actionDescriptions[action.id] ?? '' })),
      expressions: props.resource.expressions.map(expression => ({ id: expression.id, description: expressionDescriptions[expression.id] ?? '' })),
      hitAreas: (props.resource.hitAreas ?? []).map(area => ({ id: area.id, ...(hitMappings[area.id] ? { motion: hitMappings[area.id] } : {}) })),
    });
    baseline.value = serialized();
    emit('saved', resource);
  } catch (cause) {
    emit('failed', (cause as Error).message);
  } finally {
    saving.value = false;
  }
}
watch(() => props.resource.id, reset, { immediate: true });
watch(dirty, value => emit('dirty', value));
</script>
<template>
  <details class="pet-annotations">
    <summary>{{ shellText('petAnnotationsTitle') }}</summary>
    <p>{{ shellText('petAnnotationsHelp') }}</p>
    <label>
      {{ shellText('petResourceDescription') }}
      <textarea v-model="description" rows="2" maxlength="4000" :disabled="disabled || saving" />
    </label>
    <div class="annotation-grid">
      <label v-for="action in resource.actions" :key="'motion-' + action.id">
        <span>{{ action.name }} <code>{{ action.id }}</code></span>
        <input v-model="actionDescriptions[action.id]" maxlength="1000" :placeholder="shellText('petMotionDescriptionHint')" :disabled="disabled || saving">
      </label>
      <label v-for="expression in resource.expressions" :key="'expression-' + expression.id">
        <span>{{ expression.name }} <code>{{ expression.id }}</code></span>
        <input
          v-model="expressionDescriptions[expression.id]"
          maxlength="1000"
          :placeholder="shellText('petExpressionDescriptionHint')"
          :disabled="disabled || saving"
        >
      </label>
    </div>
    <template v-if="resource.hitAreas?.length">
      <h4>{{ shellText('petHitAreasTitle') }}</h4>
      <p>{{ shellText('petHitAreasHelp') }}</p>
      <div class="annotation-grid">
        <label v-for="area in resource.hitAreas" :key="area.id">
          {{ area.name }}
          <select v-model="hitMappings[area.id]" :disabled="disabled || saving">
            <option value="">{{ shellText('petHitAreaDefault') }}</option>
            <option v-for="action in resource.actions" :key="action.id" :value="action.id">
              {{ action.description || action.name }} · {{ action.id }}
            </option>
          </select>
        </label>
      </div>
    </template>
    <button :disabled="!dirty || disabled || saving" @click="save">{{ shellText('petSaveAnnotations') }}</button>
    <button :disabled="!dirty || saving" @click="reset">{{ shellText('petResetAnnotations') }}</button>
  </details>
</template>
<style scoped>
.pet-annotations {
  margin: 16px 0;
  padding-top: 12px;
  border-top: 1px solid var(--gc-border-subtle);
}
summary { cursor: pointer; }
p { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
h4 { font-size: 14px; }
label { display: flex; flex-direction: column; gap: 7px; margin: 12px 0; font-size: 12px; }
.annotation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
input, textarea, select, button {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  padding: 7px 9px;
  min-width: 0;
}
button { cursor: pointer; margin-right: 10px; }
button:disabled { opacity: .5; cursor: default; }
code { margin-left: 8px; color: var(--gc-text-muted); overflow-wrap: anywhere; }
@media (max-width: 700px) { .annotation-grid { grid-template-columns: 1fr; } }
</style>
