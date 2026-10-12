<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, reactive, ref, watch, onUnmounted } from 'vue';
import type { ExecutionNodeStatus, NodeGrant, NodeListenerSettings } from '@graycode/contracts';
import { call, subscribe } from '../api';
import NodeTasks, { type NodeTaskDraft } from './NodeTasks.vue';
import NodeScreen from './NodeScreen.vue';
import './nodePane.css';

const props = defineProps<{ visible: boolean }>();
const status = ref<ExecutionNodeStatus>();
const options = ref<{
  accounts: { id: string; displayName: string; role: string; workspaceIds: '*' | string[]; computer: boolean }[];
  workspaces: { id: string; name: string; directory: string }[];
}>();
const settings = reactive<NodeListenerSettings>({ enabled: false, name: '', host: '127.0.0.1', port: 0 });
const grant = reactive<NodeGrant>({ actorId: '', workspaceIds: [], tasks: false, computer: false });
const tab = ref<'tasks' | 'screen' | 'pair'>('tasks');
const selected = ref('');
const pairCode = ref('');
const invitation = ref<{ code: string; expiresAt: number }>();
const error = ref('');
const notice = ref('');
const busy = ref(false);
const editing = ref(false);
const stopError = ref('');
const address = ref('');
const taskDrafts = reactive<Record<string, NodeTaskDraft>>({});
let pending: Promise<void> | undefined;
let again = false;
const peers = computed(() => status.value?.peers.filter((value) => value.direction === 'outgoing' && !value.revokedAt) ?? []);
const incoming = computed(() => status.value?.peers.filter((value) => value.direction === 'incoming') ?? []);
const peer = computed(() => peers.value.find((value) => value.id === selected.value));
const account = computed(() => options.value?.accounts.find((value) => value.id === grant.actorId));
const workspaces = computed(
  () => options.value?.workspaces.filter((value) => account.value?.workspaceIds === '*' || account.value?.workspaceIds.includes(value.id)) ?? [],
);
const stateLabel = computed(() => ({
  online: t('uiNodePaneOnline'),
  offline: t('uiNodePaneOffline'),
  connecting: t('uiNodePaneConnecting'),
  revoked: t('uiNodePaneRevoked'),
}));
function draft(id: string) {
  return (taskDrafts[id] ??= { text: '', workspaceId: '', agentId: '', selectedRunId: '' });
}
function refresh() {
  if (pending) {
    again = true;
    return pending;
  }
  pending = (async () => {
    do {
      again = false;
      const [nextStatus, nextOptions] = await Promise.all([call<ExecutionNodeStatus>('nodes.status'), call<typeof options.value>('nodes.options')]);
      status.value = nextStatus;
      options.value = nextOptions;
      if (!editing.value) Object.assign(settings, status.value.settings);
      if (!selected.value || !peers.value.some((value) => value.id === selected.value)) selected.value = peers.value[0]?.id ?? '';
    } while (again);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
async function perform(action: () => Promise<void>, refreshAfter = true) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
    if (refreshAfter) await refresh();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  await call('nodes.configure', settings);
  editing.value = false;
  notice.value = t('uiNodePaneLocalEndpointSaved');
}
async function stopComputer() {
  const id = peer.value?.id;
  if (!id) return;
  stopError.value = '';
  try {
    await call('nodes.request', { peerId: id, method: 'computer.stop' });
  } catch (cause) {
    stopError.value = (cause as Error).message;
  }
}
async function pair() {
  const result = await call<{ peerId: string }>('nodes.pair', { code: pairCode.value });
  pairCode.value = '';
  selected.value = result.peerId;
  tab.value = 'tasks';
  notice.value = t('uiNodePaneDevicePaired');
}
async function copyInvitation() {
  if (!invitation.value) return;
  await navigator.clipboard.writeText(invitation.value.code);
  notice.value = t('uiNodePanePairingCodeCopied');
}
watch(
  () => grant.actorId,
  () => {
    grant.workspaceIds = [];
    if (!account.value?.computer) grant.computer = false;
    invitation.value = undefined;
  },
);
watch(
  () => peer.value?.id,
  () => {
    address.value = peer.value?.address ?? '';
  },
);
watch(
  () => props.visible,
  (visible) => {
    if (visible)
      void perform(async () => {
        await refresh();
        if (!peers.value.length) tab.value = 'pair';
      }, false);
  },
  { immediate: true },
);
const off = subscribe((event) => {
  if (
    props.visible &&
    (['nodes.changed', 'settings.changed'].includes(event.type) || (event.type === 'transport.resumed' && (event.snapshotRequired || event.authenticatedAgain)))
  )
    void refresh().catch((cause) => {
      error.value = cause.message;
    });
});
onUnmounted(off);
</script>

<template>
  <section class="node-pane" :aria-label="t('uiNodePaneExecutionDevice')">
    <header class="node-header">
      <div>
        <strong>{{ t('uiNodePaneExecutionDevice') }}</strong>
        <p>{{ t('uiNodePaneExecutionDeviceHelp') }}</p>
      </div>
      <button :disabled="busy" @click="perform(refresh, false)">{{ t('uiBrowserPaneRefresh') }}</button>
    </header>
    <div class="node-tabs">
      <button :class="{ active: tab === 'tasks' }" @click="tab = 'tasks'">{{ t('uiNodePaneRemoteTasks') }}</button>
      <button :class="{ active: tab === 'screen' }" @click="tab = 'screen'">{{ t('uiNodePaneScreenAndControls') }}</button>
      <button :class="{ active: tab === 'pair' }" @click="tab = 'pair'">{{ t('uiNodePanePairingAndPermissions') }}</button>
    </div>
    <p v-if="error" class="node-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="node-notice" role="status">{{ notice }}</p>
    <div v-if="tab !== 'pair'" class="node-target">
      <label>
        {{ t('uiNodePaneExecutionDevice') }}
        <select v-model="selected" :aria-label="t('uiNodePaneSelectExecutionDevice')">
          <option value="" disabled>{{ t('uiNodePaneSelectPairedDevice') }}</option>
          <option v-for="value in peers" :key="value.id" :value="value.id">{{ value.name }} · {{ stateLabel[value.state] }}</option>
        </select>
      </label>
      <span v-if="peer" :class="['node-connection', peer.state]">
        {{ stateLabel[peer.state] }}
        <small v-if="peer.capabilities">{{ peer.capabilities.account.displayName }} · {{ peer.capabilities.platform }}</small>
      </span>
      <button v-if="tab === 'screen' && peer?.capabilities?.computer" class="node-stop" :disabled="peer.state !== 'online'" @click="stopComputer">
        {{ t('uiNodePaneStopComputerActions') }}
      </button>
      <p v-if="tab === 'screen' && stopError" class="node-error">{{ stopError }}</p>
    </div>
    <div v-if="tab !== 'pair' && peer?.state !== 'online' && peer" class="node-reconnect">
      <p>{{ peer.error || t('uiNodePaneDeviceDisconnectedHelp') }}</p>
      <label>
        {{ t('uiNodePaneDeviceAddress') }}
        <input v-model="address" :aria-label="t('uiNodePaneExecutionDeviceAddress')" />
      </label>
      <button
        :disabled="busy"
        @click="
          perform(async () => {
            await call('nodes.connect', { id: peer!.id, address });
          })
        "
      >
        {{ t('uiNodePaneReconnect') }}
      </button>
    </div>
    <p v-if="tab !== 'pair' && !peer" class="node-empty">
      {{ t('uiNodePaneNoExecutionDevice') }}
      <button @click="tab = 'pair'">{{ t('uiNodePaneStartPairing') }}</button>
    </p>
    <NodeTasks v-if="peer" v-show="tab === 'tasks'" :key="peer.id" :peer="peer" :draft="draft(peer.id)" :visible="visible && tab === 'tasks'" />
    <NodeScreen v-if="peer" v-show="tab === 'screen'" :key="peer.id" :peer="peer" :visible="visible && tab === 'screen'" />
    <div v-show="tab === 'pair'" class="node-pairing">
      <section class="node-section">
        <h3>{{ t('uiNodePaneConnectAnotherDevice') }}</h3>
        <p>{{ t('uiNodePanePairingHelp') }}</p>
        <label>
          {{ t('uiNodePaneExecutionDevicePairingCode') }}
          <textarea
            v-model="pairCode"
            :aria-label="t('uiNodePaneExecutionDevicePairingCode')"
            autocomplete="off"
            spellcheck="false"
            placeholder="graycode-node.v1.…"
          ></textarea>
        </label>
        <button :disabled="busy || !pairCode.trim() || !status?.secureStorage" @click="perform(pair)">{{ t('uiAutomationEventFieldsPairedDevice') }}</button>
      </section>
      <section class="node-section">
        <h3>{{ t('uiNodePaneAllowOtherDevices') }}</h3>
        <p v-if="!status?.secureStorage" class="node-error">{{ t('uiNodePaneEncryptedStorageUnavailable') }}</p>
        <div class="node-fields" @input="editing = true" @change="editing = true">
          <label>
            {{ t('uiNodePaneLocalDeviceName') }}
            <input v-model="settings.name" :aria-label="t('uiNodePaneDeviceNameField')" />
          </label>
          <label>
            {{ t('uiNodePaneListenAddress') }}
            <select v-model="settings.host" :aria-label="t('uiNodePaneLocalListenAddress')">
              <option v-for="value in status?.interfaces" :key="value.address" :value="value.address">
                {{ value.address }} · {{ value.internal ? t('uiNodePaneLocalOnly') : value.name }}
              </option>
            </select>
          </label>
          <label>
            {{ t('uiNodePanePort') }}
            <input v-model.number="settings.port" type="number" min="0" max="65535" :aria-label="t('uiNodePaneExecutionEndpointPort')" />
          </label>
          <label class="node-check">
            <input v-model="settings.enabled" type="checkbox" :aria-label="t('uiNodePaneEnableLocalEndpoint')" />
            {{ t('uiNodePaneEnableLocalEndpoint') }}
          </label>
        </div>
        <p class="node-hint">{{ t('uiNodePaneListenAddressHelp') }}</p>
        <button :disabled="busy || !status?.secureStorage" @click="perform(save)">{{ t('uiNodePaneSaveExecutionEndpoint') }}</button>
        <p v-if="status?.listener.address" class="node-address">{{ status.listener.address }}</p>
        <p v-if="status?.listener.error" class="node-error">{{ status.listener.error }}</p>
        <p v-if="status?.listener.state === 'disabled'" class="node-hint">{{ t('uiNodePaneLocalEndpointDisabled') }}</p>
      </section>
      <section class="node-section">
        <h3>{{ t('uiNodePaneGenerateOneTimeCode') }}</h3>
        <label>
          {{ t('uiNodePaneRemoteConnectionAccount') }}
          <select v-model="grant.actorId" :aria-label="t('uiNodePanePairingAccount')">
            <option value="" disabled>{{ t('uiNodePaneSelectAccount') }}</option>
            <option v-for="value in options?.accounts" :key="value.id" :value="value.id">
              {{ value.displayName }} ·
              {{ value.role === 'owner' ? t('uiNodePaneOwner') : value.role === 'member' ? t('uiNodePaneMember') : t('uiNodePaneGuest') }}
            </option>
          </select>
        </label>
        <div class="node-row">
          <label class="node-check">
            <input v-model="grant.tasks" type="checkbox" :aria-label="t('uiNodePaneAllowRemoteTasks')" />
            {{ t('uiNodePaneExecuteTasks') }}
          </label>
          <label class="node-check">
            <input v-model="grant.computer" type="checkbox" :disabled="!account?.computer" :aria-label="t('uiNodePaneAllowRemoteComputerControl')" />
            {{ t('uiNodePaneViewAndControlComputer') }}
          </label>
        </div>
        <fieldset v-if="grant.tasks" class="node-workspaces">
          <legend>{{ t('uiNodePaneAllowedLocalProjects') }}</legend>
          <label v-for="value in workspaces" :key="value.id" class="node-check">
            <input v-model="grant.workspaceIds" type="checkbox" :value="value.id" />
            {{ value.name }}
            <small>{{ value.directory }}</small>
          </label>
          <p v-if="!workspaces.length" class="node-hint">{{ t('uiNodePaneNoAvailableProjects') }}</p>
        </fieldset>
        <button
          :disabled="busy || !grant.actorId || (!grant.tasks && !grant.computer) || status?.listener.state !== 'listening'"
          @click="
            perform(async () => {
              invitation = await call('nodes.invitation', grant);
            })
          "
        >
          {{ t('uiNodePaneGeneratePairingCode') }}
        </button>
        <template v-if="invitation">
          <label>
            {{ t('uiNodePaneValidUntil') }} {{ new Date(invitation.expiresAt).toLocaleTimeString(shellLocale) }}
            <textarea :value="invitation.code" :aria-label="t('uiNodePaneGeneratedPairingCode')" readonly spellcheck="false"></textarea>
          </label>
          <button @click="perform(copyInvitation)">{{ t('uiNodePaneCopyPairingCode') }}</button>
        </template>
      </section>
      <section v-if="peers.length" class="node-section">
        <h3>{{ t('uiNodePaneConnectedExecutionDevices') }}</h3>
        <div v-for="value in peers" :key="value.id" class="node-peer-row">
          <div>
            <strong>{{ value.name }}</strong>
            <p>{{ stateLabel[value.state] }} · {{ value.address }}</p>
          </div>
          <button
            :disabled="busy"
            @click="
              perform(async () => {
                await call('nodes.disconnect', { id: value.id });
              })
            "
          >
            {{ t('uiNodePaneDisconnect') }}
          </button>
          <button
            :disabled="busy || value.state !== 'online'"
            @click="
              perform(async () => {
                await call('nodes.revoke', { id: value.id });
                notice = t('uiNodePanePairingRevocationConfirmed');
              })
            "
          >
            {{ t('uiNodePaneRevokePairing') }}
          </button>
          <button
            v-if="value.state !== 'online'"
            :disabled="busy"
            @click="
              perform(async () => {
                await call('nodes.revoke', { id: value.id, localOnly: true });
                notice = t('uiNodePaneRemoveLocalConnectionHelp');
              })
            "
          >
            {{ t('uiNodePaneRemoveLocalConnection') }}
          </button>
        </div>
      </section>
      <section v-if="incoming.length" class="node-section">
        <h3>{{ t('uiNodePaneAuthorizedDevices') }}</h3>
        <div v-for="value in incoming" :key="value.id" class="node-peer-row">
          <div>
            <strong>{{ value.name }}</strong>
            <p>
              {{ stateLabel[value.state] }} {{ t('uiNodePaneAccountLabel') }}
              {{ options?.accounts.find((item) => item.id === value.grant?.actorId)?.displayName || value.grant?.actorId }}
            </p>
            <small>{{ value.grant?.tasks ? t('uiNodePaneExecuteTasks') : '' }} {{ value.grant?.computer ? t('uiNodePaneViewAndControlComputer') : '' }}</small>
          </div>
          <button
            v-if="!value.revokedAt"
            :disabled="busy"
            @click="
              perform(async () => {
                await call('nodes.revoke', { id: value.id });
                notice = t('uiNodePaneDeviceRevoked');
              })
            "
          >
            {{ t('uiNodePaneRevokeDevice') }}
          </button>
        </div>
      </section>
      <p class="node-hint">{{ t('uiNodePaneWebLoginPairingHelp') }}</p>
    </div>
  </section>
</template>
