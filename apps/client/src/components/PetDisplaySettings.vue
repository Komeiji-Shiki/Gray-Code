<script setup lang="ts">
import type { PetAnimation, PetConfiguration, PetResource } from '@graycode/contracts';
import { shellText } from '../i18n';
import { petAnimations } from '../../../../shared/petFormat';

const props = withDefaults(defineProps<{
  configuration: PetConfiguration;
  resource?: PetResource;
  floatingAvailable?: boolean;
  disabled?: boolean;
  mode?: 'all' | 'preferences' | 'interaction';
}>(), { mode: 'all' });
const emit = defineEmits<{ save: []; discard: [] }>();
const taskStates = petAnimations.filter(item => ['idle', 'running', 'waiting', 'review', 'failed'].includes(item.id));
const animationText: Record<PetAnimation, Parameters<typeof shellText>[0]> = {
  idle: 'petAnimationIdle', 'running-right': 'petAnimationRight', 'running-left': 'petAnimationLeft',
  waving: 'petAnimationWaving', jumping: 'petAnimationJumping', failed: 'petAnimationFailed',
  waiting: 'petAnimationWaiting', running: 'petAnimationRunning', review: 'petAnimationReview',
};

function setMapping(state: PetAnimation, event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (id) props.configuration.mappings[state] = id;
  else delete props.configuration.mappings[state];
}
</script>
<template>
  <fieldset class="pet-display-settings">
    <legend>{{ shellText(mode === 'interaction' ? 'petInteractionSettings' : 'petDisplaySettings') }}</legend>
    <div class="control-grid">
      <label v-if="mode !== 'preferences'">{{ shellText('petSurface') }}
        <select v-model="configuration.surface" :disabled="disabled">
          <option value="app">{{ shellText('petSurfaceApp') }}</option>
          <option value="floating" :disabled="!floatingAvailable">{{ shellText('petSurfaceFloating') }}</option>
        </select>
      </label>
      <label v-if="mode !== 'interaction'">{{ shellText('petScale', { scale: configuration.scale.toFixed(1) }) }}
        <input
          v-model.number="configuration.scale" type="range" min="0.4" max="3" step="0.1"
          :disabled="disabled" :aria-label="shellText('petScaleLabel')"
        >
        <small>{{ shellText('petScaleHelp') }}</small>
      </label>
    </div>
    <template v-if="mode !== 'interaction'">
      <label class="check">
        <input v-model="configuration.visible" type="checkbox" :disabled="disabled || mode === 'preferences' && !configuration.resourceId">
        {{ shellText('petVisible') }}
      </label>
      <p v-if="mode === 'preferences' && !configuration.resourceId">{{ shellText('petSelectCompanionFirst') }}</p>
    </template>
    <template v-if="mode !== 'preferences'">
      <label class="check"><input v-model="configuration.reducedMotion" type="checkbox" :disabled="disabled">{{ shellText('petReducedMotion') }}</label>
      <p>{{ shellText('petReducedMotionHelp') }}</p>
      <label class="check"><input v-model="configuration.stopped" type="checkbox" :disabled="disabled">{{ shellText('petStopped') }}</label>
      <label class="check"><input v-model="configuration.taskAnimations" type="checkbox" :disabled="disabled">{{ shellText('petTaskAnimations') }}</label>
      <p>{{ shellText('petTaskAnimationsHelp') }}</p>
      <div v-if="resource?.kind === 'live2d' && configuration.resourceId === resource.id" class="control-grid">
        <label v-for="state in taskStates" :key="state.id">
          {{ shellText(animationText[state.id]) }}
          <select :value="configuration.mappings[state.id] ?? ''" :disabled="disabled" @change="setMapping(state.id, $event)">
            <option value="">{{ shellText('petNoMapping') }}</option>
            <option v-for="item in resource.actions" :key="item.id" :value="item.id">{{ item.description || item.name }} · {{ item.id }}</option>
          </select>
        </label>
      </div>
      <label class="check"><input v-model="configuration.followPointer" type="checkbox" :disabled="disabled">{{ shellText('petFollowPointer') }}</label>
      <label class="check"><input v-model="configuration.soundEnabled" type="checkbox" :disabled="disabled">{{ shellText('petSoundEnabled') }}</label>
      <label class="check"><input v-model="configuration.speechEnabled" type="checkbox" :disabled="disabled">{{ shellText('petSpeechEnabled') }}</label>
      <p>{{ shellText('petSpeechHelp') }}</p>
    </template>
    <div class="actions">
      <button class="primary" type="button" :disabled="disabled" @click="emit('save')">
        {{ shellText(mode === 'preferences' ? 'petSaveDisplayPreferences' : mode === 'interaction' ? 'petSaveInteraction' : 'petSaveConfiguration') }}
      </button>
      <button type="button" :disabled="disabled" @click="emit('discard')">{{ shellText('petDiscardConfiguration') }}</button>
    </div>
    <p v-if="mode !== 'preferences'">{{ shellText('petPriorityHelp') }}</p>
  </fieldset>
</template>
<style scoped>
fieldset { margin: 24px 0; border: 1px solid var(--gc-border-subtle); padding: 14px 18px; min-width: 0; }
legend { padding: 0 6px; font-size: 13px; }
.control-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; min-width: 0; }
label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; margin: 12px 0; }
.check { flex-direction: row; align-items: center; }
button, input, select {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  padding: 7px 9px;
  min-width: 0;
  box-sizing: border-box;
}
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
input[type=checkbox] { margin: 0; }
input[type=range] { padding: 0; }
p, small { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); }
@media (max-width: 700px) { .control-grid { grid-template-columns: 1fr; } }
</style>
