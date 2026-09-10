<script setup lang="ts">
import { computed } from 'vue';
import type { MigrationStatus } from '../../../../packages/contracts/src';
const props = defineProps<{ status: MigrationStatus; now: number; starting: boolean }>();
const progress = computed(() => props.status.progress);
const phases = { scanning: '扫描目录', history: '对话历史', artifacts: '分支、检查点与附件', memory: '长期记忆', skills: '技能', activity: '使用时间', runtimeAssets: '依赖与词表', configuration: '旧配置', finalizing: '整理结果' };
const percentage = computed(() => {
  const value = progress.value;
  if (value?.completed === undefined || !value.total) return undefined;
  return Math.min(100, Math.floor(value.completed / value.total * 100));
});
const elapsed = computed(() => Math.max(0, Math.floor((props.now - (props.status.startedAt ?? props.now)) / 1000)));
const secondsSinceUpdate = computed(() => Math.max(0, Math.floor((props.now - (props.status.updatedAt ?? props.now)) / 1000)));
const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`;
</script>

<template>
  <div class="migration-progress" role="status" aria-live="polite">
    <div class="progress-heading"><strong>{{ status.state === 'cancelling' ? '正在取消迁移' : progress ? phases[progress.phase] : '准备迁移' }}</strong><span>已用 {{ Math.floor(elapsed / 60) }} 分 {{ elapsed % 60 }} 秒</span></div>
    <div class="progress-track" role="progressbar" :aria-label="progress ? `${phases[progress.phase]}阶段进度` : '准备迁移'" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100" :class="{ indeterminate: percentage === undefined }">
      <div class="progress-fill" :style="percentage === undefined ? undefined : { width: `${percentage}%` }"></div>
    </div>
    <div class="progress-detail"><span>{{ starting ? '提交迁移任务…' : progress?.detail }}</span><span v-if="percentage !== undefined">{{ progress?.completed }} / {{ progress?.total }} {{ progress?.unit }} · {{ percentage }}%</span></div>
    <p v-if="progress?.currentItem" class="progress-item" :title="progress.currentItem">{{ progress.currentItem }}</p>
    <p v-if="progress?.importedMessages !== undefined">当前对话已保存 {{ progress.importedMessages }} 条消息。</p>
    <p v-if="progress?.processedBytes !== undefined && progress.totalBytes !== undefined">当前文件：{{ bytes(progress.processedBytes) }} / {{ bytes(progress.totalBytes) }}</p>
    <p v-if="status.state === 'cancelling'">正在等待当前写入结束。已保存的数据会保留，再次选择同一来源可以继续迁移。</p>
    <p v-else-if="secondsSinceUpdate >= 15" class="progress-wait">已有 {{ secondsSinceUpdate }} 秒没有新的处理进度。当前步骤可能仍在计算或等待资源，可以取消后重试。</p>
    <p v-else>进度条表示当前阶段。迁移在后台继续，重新打开设置页可以查看进度。</p>
  </div>
</template>

<style scoped>
.migration-progress{margin-top:14px;padding:14px;border:1px solid var(--gc-border-subtle);background:var(--gc-surface-base);font-size:12px}
.progress-heading,.progress-detail{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.progress-heading{margin-bottom:12px}.progress-heading span{color:var(--gc-text-muted);font-variant-numeric:tabular-nums}
.progress-track{height:5px;overflow:hidden;background:var(--gc-border-subtle);margin-bottom:10px}.progress-fill{height:100%;background:var(--vscode-button-background);transition:width .15s linear}.indeterminate .progress-fill{width:30%;animation:migration-progress 1.6s linear infinite}
p{margin:7px 0 0;line-height:1.6;color:var(--gc-text-muted)}.progress-item{overflow-wrap:anywhere}.progress-wait{color:var(--gc-text-primary)}
@keyframes migration-progress{from{transform:translateX(-100%)}to{transform:translateX(334%)}}@media(prefers-reduced-motion:reduce){.indeterminate .progress-fill{animation:none}.progress-fill{transition:none}}
</style>
