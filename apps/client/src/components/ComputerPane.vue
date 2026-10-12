<script setup lang="ts">
import { computed } from 'vue';

import { shellText as t, shellLocale } from '../i18n';
import { rpc as call } from '../api';
import { useComputerPane } from './useComputerPane';
import './computerPane.css';

const props = defineProps<{ visible: boolean }>();
const controlLabels = computed<Record<string, string>>(() => ({
  Window: t('uiComputerPaneWindow'),
  Text: t('uiComputerPaneText'),
  Document: t('uiComputerPaneBodyText'),
  Edit: t('uiComputerPaneInputField'),
  Button: t('uiComputerPaneButton'),
  Pane: t('uiComputerPaneRegion'),
  ScrollBar: t('uiComputerPaneScrollbar'),
  CheckBox: t('uiComputerPaneCheckbox'),
  RadioButton: t('uiComputerPaneRadioButton'),
  ComboBox: t('uiComputerPaneDropdown'),
  List: t('uiComputerPaneList'),
  ListItem: t('uiComputerPaneListItem'),
  Menu: t('uiComputerPaneMenu'),
  MenuItem: t('uiComputerPaneMenuItem'),
  Tab: t('uiComputerPaneTabGroup'),
  TabItem: t('uiComputerPaneTab'),
  Tree: t('uiComputerPaneTreeView'),
  TreeItem: t('uiComputerPaneTreeItem'),
  Slider: t('uiComputerPaneSlider'),
  ToolBar: t('uiComputerPaneToolbar'),
  Group: t('uiComputerPaneGroup'),
  Custom: t('uiComputerPaneCustom'),
}));
const actionLabels = computed<Record<string, string>>(() => ({
  focusWindow: t('uiComputerPaneSwitchWindow'),
  focusElement: t('uiComputerPaneFocusElement'),
  invoke: t('uiComputerPaneClickElement'),
  setValue: t('uiComputerPaneFillContent'),
  select: t('uiComputerPaneSelect'),
  toggle: t('uiComputerPaneToggleState'),
  expand: t('uiComputerPaneExpand'),
  collapse: t('uiComputerPaneCollapse'),
  click: t('uiComputerPaneClick'),
  type: t('uiComputerPaneTypeText'),
  key: t('uiComputerPaneSendKeystrokes'),
  scroll: t('uiComputerPaneScroll'),
  drag: t('uiComputerPaneDrag'),
}));
const resultLabels = computed<Record<string, string>>(() => ({
  dispatching: t('uiComputerPaneDispatched'),
  completed: t('uiComputerPaneCompleted'),
  failed: t('uiComputerPaneFailure'),
  unknown: t('uiComputerPaneResultUnverified'),
}));
const {
  inventory,
  selectedWindow,
  observation,
  selectedElement,
  filter,
  text,
  key,
  error,
  notice,
  busy,
  history,
  tab,
  pointerMode,
  imageSize,
  actualSize,
  windows,
  element,
  elements,
  status,
  imageUrl,
  patternActions,
  perform,
  readWindows,
  observe,
  chooseWindow,
  chooseTab,
  action,
  chooseElement,
  pointerDown,
  pointerUp,
  cancelPointer,
} = useComputerPane(() => props.visible);
</script>

<template>
  <section class="computer-pane" :aria-label="t('uiComputerPaneComputerControl')" :aria-busy="busy">
    <header class="computer-toolbar">
      <div>
        <strong>{{ t('uiComputerPaneLocalComputer') }}</strong>
        <span>{{ status?.active ? t('uiComputerPaneControlling') : t('uiComputerPaneViewWindow') }}</span>
      </div>
      <button v-if="status?.active" class="computer-stop" @click="call('computer.stop').catch((cause) => (error = cause.message))">
        {{ t('uiComputerPaneStopNow') }}
      </button>
      <button :disabled="busy" :title="t('uiComputerPaneRefreshWindowsHelp')" @click="perform(readWindows)">{{ t('uiComputerPaneRefreshWindows') }}</button>
    </header>
    <p v-if="status?.error" class="computer-error">{{ status.error }}</p>
    <p v-if="error" class="computer-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="computer-notice" role="status">{{ notice }}</p>
    <div v-if="status?.pausedRunId" class="computer-paused">
      <span>{{ t('uiComputerPaneUserControlPaused') }}</span>
      <button :disabled="busy" @click="perform(() => call('computer.allowRun', { runId: status!.pausedRunId! }))">
        {{ t('uiComputerPaneAllowTaskContinue') }}
      </button>
    </div>
    <div class="computer-target">
      <label for="computer-window">{{ t('uiComputerPaneTargetWindow') }}</label>
      <select id="computer-window" :value="selectedWindow" :disabled="busy" @change="perform(() => chooseWindow(($event.target as HTMLSelectElement).value))">
        <option value="">{{ t('uiComputerPaneSelectWindow') }}</option>
        <option v-for="item in windows" :key="item.id" :value="item.id">
          {{ item.title || t('uiComputerPaneUntitledWindow') }} · {{ item.processId }}{{ item.minimized ? t('uiComputerPaneMinimizedSuffix') : '' }}
        </option>
      </select>
      <details class="computer-window-filter">
        <summary :title="t('uiComputerPaneFilterWindowsAndDisplays')">{{ t('uiComputerPaneFilter') }}</summary>
        <div>
          <input v-model="filter" type="search" :placeholder="t('uiComputerPaneWindowFilterPlaceholder')" :aria-label="t('uiComputerPaneFindWindow')" />
          <p>{{ windows.length }} {{ t('uiComputerPaneMatchingWindows') }}</p>
          <p v-for="display in inventory?.displays" :key="display.id">
            {{ display.id }} · {{ display.bounds.width }} × {{ display.bounds.height }} · {{ Math.round(display.scaleFactor * 100) }}%
          </p>
        </div>
      </details>
    </div>
    <nav class="computer-tabs" :aria-label="t('uiComputerPanePanelView')">
      <button :aria-pressed="tab === 'screen'" :disabled="busy" @click="perform(() => chooseTab('screen'))">{{ t('uiComputerPaneScreen') }}</button>
      <button :aria-pressed="tab === 'controls'" :disabled="busy" @click="perform(() => chooseTab('controls'))">
        {{ t('uiComputerPaneElementsAndInput') }}
      </button>
      <button :aria-pressed="tab === 'history'" :disabled="busy" @click="perform(() => chooseTab('history'))">{{ t('uiComputerPaneActionHistory') }}</button>
    </nav>
    <div v-if="tab === 'history'" class="computer-history">
      <p v-if="!history.length" class="computer-hint">{{ t('uiComputerPaneEmptyActionHistory') }}</p>
      <article v-for="entry in history" :key="entry.id">
        <strong>{{ actionLabels[entry.action] || entry.action }} · {{ entry.window.title }}</strong>
        <span>{{ resultLabels[entry.status] || entry.status }} · {{ new Date(entry.requestedAt).toLocaleString(shellLocale) }}</span>
        <code>PID {{ entry.window.processId }} · {{ entry.window.executable }}</code>
        <p v-if="entry.error">{{ entry.error }}</p>
      </article>
    </div>
    <template v-else>
      <div class="computer-observe-toolbar">
        <button :disabled="busy || !selectedWindow" @click="perform(observe)">
          {{ busy ? t('uiComputerPaneLoading') : t('uiComputerPaneRefreshScreenshot') }}
        </button>
        <button :disabled="busy || !observation" @click="perform(() => action({ action: 'focusWindow' }))">{{ t('uiComputerPaneActivateWindow') }}</button>
        <label>
          {{ t('uiComputerPaneImageQuality') }}
          <select v-model.number="imageSize" :disabled="busy" @change="perform(observe)">
            <option :value="1280">{{ t('uiComputerPaneQualityStandard') }}</option>
            <option :value="1920">{{ t('uiComputerPaneQualityClear') }}</option>
            <option :value="2560">{{ t('uiComputerPaneQualityDetailed') }}</option>
          </select>
        </label>
      </div>
      <template v-if="observation">
        <details class="computer-identity">
          <summary>
            <span>{{ observation.window.title }}</span>
            <time>{{ new Date(observation.capturedAt).toLocaleTimeString(shellLocale) }}</time>
          </summary>
          <dl>
            <dt>{{ t('uiComputerPaneProcess') }}</dt>
            <dd>{{ observation.window.processId }} · {{ observation.window.executable || t('uiComputerPanePathUnavailable') }}</dd>
            <dt>{{ t('uiComputerPaneStartTime') }}</dt>
            <dd>{{ observation.window.processStartedAt || t('uiComputerPaneUnreadable') }}</dd>
            <dt v-if="observation.window.commandLine">{{ t('uiComputerPaneCommand') }}</dt>
            <dd v-if="observation.window.commandLine">{{ observation.window.commandLine }}</dd>
            <dt>{{ t('uiComputerPaneWindowPosition') }}</dt>
            <dd>
              {{ observation.window.bounds.x }}, {{ observation.window.bounds.y }} · {{ observation.window.bounds.width }} ×
              {{ observation.window.bounds.height }} · {{ observation.window.dpi }} DPI
            </dd>
          </dl>
        </details>
        <p v-if="observation.accessibilityError" class="computer-error">{{ observation.accessibilityError }}</p>
        <template v-if="tab === 'screen'">
          <div v-if="imageUrl" class="computer-picture-toolbar">
            <select v-model="pointerMode" :disabled="busy" :aria-label="t('uiComputerPaneScreenshotAction')">
              <option value="inspect">{{ t('uiComputerPaneViewOnly') }}</option>
              <option value="click">{{ t('uiComputerPaneSingleClick') }}</option>
              <option value="double">{{ t('uiComputerPaneDoubleClick') }}</option>
              <option value="right">{{ t('uiComputerPaneRightClick') }}</option>
              <option value="drag">{{ t('uiComputerPaneDrag') }}</option>
            </select>
            <button :aria-pressed="actualSize" @click="actualSize = !actualSize">
              {{ actualSize ? t('uiComputerPaneFitToPanel') : t('uiComputerPaneOriginalPixels') }}
            </button>
            <span>{{ observation.screenshot!.width }} × {{ observation.screenshot!.height }}</span>
          </div>
          <div v-if="imageUrl" class="computer-stage" :class="{ 'actual-size': actualSize }">
            <img
              :src="imageUrl"
              :alt="t('uiComputerPaneWindowScreenshotAlt')"
              draggable="false"
              :class="{ interactive: pointerMode !== 'inspect' }"
              @pointerdown="pointerDown"
              @pointerup="pointerUp"
              @pointercancel="cancelPointer"
              @lostpointercapture="cancelPointer"
            />
          </div>
          <div v-else class="computer-empty">
            <strong>{{ t('uiComputerPaneScreenshotUnavailable') }}</strong>
            <p>{{ t('uiComputerPaneMinimizedWindowHelp') }}</p>
          </div>
          <p class="computer-caption">
            {{ pointerMode === 'inspect' ? t('uiComputerPaneScreenshotLocationHelp') : t('uiComputerPaneScreenshotActionHelp') }}
            {{ t('uiComputerPaneImageQualityHelp') }}
          </p>
        </template>
        <div v-else class="computer-controls">
          <div class="computer-elements" :aria-label="t('uiComputerPaneVisibleElements')">
            <button
              v-for="item in elements"
              :key="item.id"
              :aria-pressed="selectedElement === item.id"
              :disabled="busy || !item.enabled"
              @click="chooseElement(item)"
            >
              <small :title="item.type">{{ controlLabels[item.type] || item.type }}</small>
              <span>{{ item.name || item.automationId || t('uiComputerPaneUnnamedElement') }}</span>
              <small v-if="item.focused">{{ t('uiComputerPaneFocus') }}</small>
              <span v-if="item.value" class="computer-value">{{ item.value }}</span>
            </button>
          </div>
          <p v-if="!elements.length" class="computer-hint">{{ t('uiComputerPaneNoVisibleElements') }}</p>
          <p v-if="observation.truncated" class="computer-hint">{{ t('uiComputerPaneTruncatedElementsHelp') }}</p>
          <div class="computer-input">
            <p>{{ element ? t('uiComputerPaneSelectedElement', { value1: element.name || element.type }) : t('uiComputerPaneElementInputHelp') }}</p>
            <textarea
              v-model="text"
              :placeholder="t('uiComputerPaneTextToEnter')"
              :aria-label="t('uiComputerPaneComputerTextInput')"
              :disabled="busy"
              rows="3"
            ></textarea>
            <div>
              <button
                v-for="[, type, label] in patternActions"
                :key="type"
                :disabled="busy || element?.password"
                @click="perform(() => action({ action: type, elementId: selectedElement, text }))"
              >
                {{ label }}
              </button>
              <button :disabled="busy || !element || element.password" @click="perform(() => action({ action: 'focusElement', elementId: selectedElement }))">
                {{ t('uiComputerPaneFocusElement') }}
              </button>
              <button
                :disabled="busy || !text || element?.password || (!element && !observation.focusedElementId)"
                @click="perform(() => action({ action: 'type', text, elementId: selectedElement || undefined }))"
              >
                {{ t('uiComputerPaneTypeIntoFocus') }}
              </button>
            </div>
            <div>
              <input v-model="key" :aria-label="t('uiComputerPaneKeyCombination')" placeholder="Control+A" />
              <button :disabled="busy || !key" @click="perform(() => action({ action: 'key', key, elementId: selectedElement || undefined }))">
                {{ t('uiComputerPaneSendKeystrokes') }}
              </button>
              <button :disabled="busy || !element" @click="perform(() => action({ action: 'scroll', elementId: selectedElement, scrollY: 3 }))">
                {{ t('uiComputerPaneScrollDown') }}
              </button>
              <button :disabled="busy || !element" @click="perform(() => action({ action: 'scroll', elementId: selectedElement, scrollY: -3 }))">
                {{ t('uiComputerPaneScrollUp') }}
              </button>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="computer-empty">
        <span class="computer-empty-icon" aria-hidden="true">▣</span>
        <strong>{{ busy ? t('uiComputerPaneReadingWindow') : t('uiComputerPaneSelectWindowPrompt') }}</strong>
        <p>{{ t('uiComputerPaneScreenInteractionHelp') }}</p>
      </div>
    </template>
  </section>
</template>
