import { computed, onBeforeUnmount, ref, toValue, type MaybeRefOrGetter } from 'vue';
import type { BotStatus } from '../../../packages/contracts/src/bots';
import { onExtensionCommand, sendToExtension } from '../utils/vscode';

const labels: Record<string, string> = {
  loading: '正在读取状态', stopped: '已断开', connecting: '正在连接', connected: '已连接',
  reconnecting: '正在重连', disconnected: '连接已断开', connection_error: '连接异常', failed: '连接失败',
};

export function useBotConnectionStatus(platform: MaybeRefOrGetter<'discord' | 'onebot'>) {
  const status = ref<BotStatus>({ status: 'loading' });
  let revision = 0;
  const unsubscribe = onExtensionCommand<{ platform: string; status: BotStatus }>('bot.connection.changed', value => {
    if (value.platform !== toValue(platform)) return;
    revision++;
    status.value = value.status;
  });
  onBeforeUnmount(() => { revision++; unsubscribe(); });

  async function requestStatus(operation: 'status' | 'start') {
    const target = toValue(platform), request = ++revision;
    const result = await sendToExtension<BotStatus>(`platform.${target}.${operation}`, {});
    // 连接通知比早先发出的查询更新，迟到的回复不能恢复旧状态。
    if (request === revision && target === toValue(platform)) status.value = result;
  }

  return {
    status,
    statusLabel: computed(() => labels[status.value.status] ?? status.value.status),
    refreshStatus: () => requestStatus('status'),
    startConnection: () => requestStatus('start'),
  };
}
