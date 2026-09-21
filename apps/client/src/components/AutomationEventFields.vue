<script setup lang="ts">
import type { AutomationOptions } from '@graycode/contracts';
import type { AutomationEventForm } from './automationEventForm';
const form = defineModel<AutomationEventForm>({ required: true });
defineProps<{ options: AutomationOptions }>();
</script>
<template>
  <fieldset class="event-fields"><legend>事件触发条件</legend>
    <label>事件来源<select v-model="form.type" required aria-label="事件来源"><option value="" disabled>请选择来源</option><option value="run_completed">指定对话中的任务完成</option><option value="file_changed">工作区中的文件变化</option><option value="node_online">已配对设备上线或恢复连接</option></select></label>
    <label v-if="form.type === 'run_completed'">来源对话<select v-model="form.conversationId" required aria-label="事件来源对话"><option value="" disabled>请选择对话</option><option v-for="row in options.eventConversations" :key="row.id" :value="row.id">{{ row.title }}</option></select></label>
    <template v-if="form.type === 'file_changed'">
      <label>监控工作区<select v-model="form.workspaceId" required aria-label="事件监控工作区"><option value="" disabled>请选择工作区</option><option v-for="row in options.workspaces" :key="row.id" :value="row.id">{{ row.name }}</option></select></label>
      <label>监控文件<input v-model="form.path" required placeholder="例如：src/main.ts" aria-label="事件监控文件" /></label>
      <label>连续变化的合并等待时间（毫秒）<input v-model="form.debounceMs" type="number" min="100" max="60000" step="1" required aria-label="事件合并等待时间" /><small class="settings-help">1000 毫秒等于 1 秒。编辑器连续保存可用 500～1000 毫秒；批量生成文件可适当延长。数值越大，重复触发越少，但开始处理也越晚。</small></label>
      <p>监控文件的创建、内容改变和删除。父目录须已存在；重启后继续监听时，会比较关闭前后的内容。</p>
      <p>文件通知无法识别写入者。为阻止跨工作区循环，文件变化会关联当时正在运行的自动任务；如果来源链包含本任务，将跳过并保留原因。本任务运行期间，该文件的新变化也会跳过。</p>
    </template>
    <label v-if="form.type === 'node_online'">配对设备<select v-model="form.peerId" required aria-label="事件配对设备"><option value="" disabled>请选择设备</option><option v-for="row in options.eventPeers" :key="row.id" :value="row.id">{{ row.name }}</option></select></label>
    <label>任务忙碌期间的新事件<select v-model="form.busyPolicy" required aria-label="事件忙碌处理"><option value="" disabled>请选择处理方式</option><option value="skip">跳过，并保留原因</option><option value="latest">合并为最新事件，本轮结束后执行一次</option></select></label>
    <label>应用重启之后<select v-model="form.restartPolicy" required aria-label="事件重启处理"><option value="" disabled>请选择处理方式</option><option value="pause">保留记录并暂停，手动继续监听</option><option value="resume">继续监听，恢复已接收的待执行事件</option></select></label>
    <p>如果退出时任务尚未完成，重启后会暂停等待检查。暂停会取消待执行事件，继续监听时不会补跑暂停期间的变化。</p>
  </fieldset>
</template>
<style scoped>
.event-fields { min-width: 0; margin: 0; border: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
legend, label { font-size: 13px; } label { display: flex; flex-direction: column; gap: 7px; }
input, select { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px; background: var(--bg); color: var(--text); font: inherit; border: 1px solid var(--border); border-radius: 0; }
p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
</style>
