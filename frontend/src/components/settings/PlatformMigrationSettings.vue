<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import MigrationWorkspaceBinding from './MigrationWorkspaceBinding.vue';
import MigrationProgress from './MigrationProgress.vue';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';
import { flushDesktopSettings } from '../../platform/settingsDraft';
import type { AppSettings, MigrationReport, MigrationStatus } from '../../../../packages/contracts/src';
type PlatformMigrationReport = MigrationReport & { operationId: string; runtimeAssets?: { imported: string[]; skipped: string[] }; activity?: { imported: string[]; skipped: string[] }; configurationFiles?: { id: string; path: string; label: string; saved: boolean }[]; memory?: { imported: string[]; skipped: string[] }; skills?: { imported: string[]; skipped: string[] } };
const source = ref(''); const starting = ref(false); const error = ref(''); const report = ref<PlatformMigrationReport>();
const migration = ref<MigrationStatus>({ active: false });
const busy = computed(() => starting.value || migration.value.active);
const now = ref(Date.now());
let disposed = false; let polling = false; let loadingReport = '';
async function loadReport(operationId: string) {
  if (loadingReport === operationId || report.value?.operationId === operationId) return;
  loadingReport = operationId;
  try {
    const value = await sendToExtension<PlatformMigrationReport>('migration.report', { operationId });
    if (!disposed && (!migration.value.operationId || migration.value.operationId === operationId)) report.value = value;
  } catch (cause) { if (!disposed) error.value = (cause as Error).message; }
  finally { if (loadingReport === operationId) loadingReport = ''; }
}
function applyStatus(value: MigrationStatus) {
  if (disposed || (value.updatedAt ?? 0) < (migration.value.updatedAt ?? 0)) return;
  migration.value = value;
  if (value.source) source.value = value.source;
  if (value.error) error.value = value.error;
  if (value.active) report.value = undefined;
  if (value.state === 'completed' && value.operationId) void loadReport(value.operationId);
}
async function refreshStatus() {
  if (polling) return;
  polling = true;
  try { applyStatus(await sendToExtension<MigrationStatus>('migration.status', {})); }
  catch (cause) { if (!disposed) error.value = (cause as Error).message; }
  finally { polling = false; }
}
const clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
// 事件用于即时更新，低频查询负责补回漏掉的完成消息与重新连接状态。
const poll = window.setInterval(() => { if (migration.value.active) void refreshStatus(); }, 2500);
const workspaces = ref<AppSettings['workspaces']>([]);
const staging = ref(''); const staged = ref<Record<string, boolean>>({});
onMounted(async () => {
  try {
    await refreshStatus();
    const [settings, latest] = await Promise.all([sendToExtension<AppSettings>('platform.settings.get', {}), sendToExtension<PlatformMigrationReport | null>('migration.latest', {})]);
    workspaces.value = settings.workspaces;
    if (latest && !busy.value && !migration.value.operationId && !source.value) { report.value = latest; source.value = latest.source; }
  }
  catch (cause) { error.value = (cause as Error).message; }
});
async function choose() {
  try { const selected = await sendToExtension<{ directory: string } | null>('desktop.chooseWorkspace', {}); if (selected) source.value = selected.directory; }
  catch (cause) { error.value = (cause as Error).message; }
}
async function start() {
  if (!source.value || busy.value) return;
  starting.value = true; error.value = ''; report.value = undefined;
  try {
    await flushDesktopSettings(); staged.value = {};
    applyStatus(await sendToExtension<MigrationStatus>('migration.start', { source: source.value }));
  }
  catch (cause) { error.value = (cause as Error).message; }
  finally { starting.value = false; }
}
async function stage(fileId: string) {
  if (!report.value || staging.value) return;
  const operationId = report.value.operationId;
  staging.value = fileId; error.value = '';
  try { await flushDesktopSettings(); await sendToExtension('migration.stageConfiguration', { operationId, fileId }); staged.value[fileId] = true; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { staging.value = ''; }
}
const dispose = onMessageFromExtension(message => {
  if (message.type === 'command' && message.command === 'migration.progress') applyStatus(message.data);
  if (message.type === 'command' && message.command === 'migration.completed') void loadReport(message.data.operationId);
  if (message.type === 'command' && message.command === 'migration.configuration.saved' && report.value && message.data?.operationIds?.includes(report.value.operationId)) {
    const operationId = report.value.operationId;
    void sendToExtension<PlatformMigrationReport>('migration.report', { operationId }).then(value => { if (report.value?.operationId === operationId) report.value = value; }).catch(cause => { error.value = cause.message; });
  }
});
onUnmounted(() => { disposed = true; dispose(); window.clearInterval(clock); window.clearInterval(poll); });
async function cancel() { try { await sendToExtension('migration.cancel', {}); await refreshStatus(); } catch (cause) { error.value = (cause as Error).message; } }
</script>
<template><section class="migration-settings" data-preference-transient>
  <h4>旧存档迁移</h4><p>选择包含 conversations、checkpoints 等目录的旧 GrayCode 数据文件夹。迁移会复制到独立存储，原文件保持不变。</p><p>现用的 VS Code 设置和模型渠道保存在 VS Code 中。请先从原扩展导出设置文件，再使用本页下方的“导入设置”；目录迁移会另外识别旧版文件设置、技能和记忆。</p>
  <div class="migration-source"><input v-model="source" placeholder="旧数据目录" aria-label="旧数据目录" :disabled="busy" /><button :disabled="busy" @click="choose">选择目录</button><button v-if="!busy" class="primary" :disabled="!source" @click="start">{{ migration.state === 'cancelled' || migration.state === 'failed' ? '继续迁移' : '开始迁移' }}</button><button v-else :disabled="starting || migration.state === 'cancelling'" @click="cancel">{{ migration.state === 'cancelling' ? '正在取消…' : '取消迁移' }}</button></div>
  <MigrationProgress v-if="busy" :status="migration" :now="now" :starting="starting" />
  <p v-if="error" class="migration-error" role="alert">{{ error }}</p>
  <div v-if="report" class="migration-result"><strong>{{ report.readyForCutover ? '所选存档已完成导入' : '导入结束，仍有需要处理的数据' }}</strong><p>新导入 {{ report.imported.length }} 个对话，已导入过 {{ report.skipped.length }} 个，{{ report.issues.length }} 个问题。</p>
    <p v-if="report.memory">长期记忆：新导入 {{ report.memory.imported.length }} 个作用域，已导入过 {{ report.memory.skipped.length }} 个。</p>
    <p v-if="report.runtimeAssets">依赖与词表目录：新导入 {{ report.runtimeAssets.imported.length }} 个，内容相同 {{ report.runtimeAssets.skipped.length }} 个。原生依赖能否加载以实际运行结果为准。</p>
    <p v-if="report.activity">使用时间记录：新导入 {{ report.activity.imported.length }} 天，已导入过 {{ report.activity.skipped.length }} 天。</p>
    <p v-if="report.skills">技能：新导入 {{ report.skills.imported.length }} 个，已导入过 {{ report.skills.skipped.length }} 个。</p>
    <div v-if="report.configurationFiles?.length" class="migration-configurations">
      <strong>旧配置</strong><p>加入设置草稿后，可以查看和调整，再使用设置页面的统一保存。保存前不会标记为完成；旧存储路径不会替换新版数据目录。</p>
      <div v-for="file in report.configurationFiles" :key="file.id" class="migration-binding">
        <span>{{ file.label }} · {{ file.path }}</span>
        <button :disabled="!!staging || file.saved || staged[file.id]" @click="stage(file.id)">{{ file.saved ? '已导入' : staging === file.id ? '正在读取…' : staged[file.id] ? '已加入草稿，等待保存' : '加入设置草稿' }}</button>
      </div>
    </div>
    <details v-if="report.imported.length || report.skipped.length"><summary>绑定迁入对话的工作区</summary>
      <p>选择此对话接下来使用的目录。绑定只修改对话和检查点归属，不会写入目录中的文件。多目录存档需要逐个选择对应目录。恢复范围保留每个检查点当时记录的目录。</p>
      <p v-if="!workspaces.length">请先在主界面添加工作区，再打开这里。</p>
      <MigrationWorkspaceBinding v-for="id in [...report.imported, ...report.skipped]" :key="id" :conversation-id="id" :workspaces="workspaces" @error="error = $event" />
    </details>
    <details v-if="report.issues.length"><summary>查看具体问题</summary><p v-for="(issue,index) in report.issues" :key="index">{{ issue.path }}：{{ issue.message }}</p></details>
    <details v-if="report.pendingArtifacts.length"><summary>尚未处理的文件（{{ report.pendingArtifacts.length }}）</summary><ul><li v-for="file in report.pendingArtifacts" :key="file">{{ file }}</li></ul></details>
  </div>
</section></template>
<style scoped>
.migration-settings{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--gc-border-subtle)}
.migration-binding{display:flex;gap:8px;align-items:center;margin-top:10px}.migration-binding code{max-width:30%;overflow:hidden;text-overflow:ellipsis}.migration-binding select{min-width:0;flex:1;padding:8px;background:var(--gc-surface-base);color:var(--gc-text-primary);border:1px solid var(--gc-border-control)}
.migration-settings{margin-top:24px;padding-top:20px;border-top:1px solid var(--gc-border-subtle)}h4{font-size:15px;margin:0 0 8px}p{font-size:12px;color:var(--gc-text-muted);line-height:1.6}.migration-source{display:flex;gap:8px;margin-top:14px}.migration-source input{flex:1;width:0;min-width:100px}button,input{background:var(--gc-surface-base);color:var(--gc-text-primary);border:1px solid var(--gc-border-control);padding:8px 10px;font:inherit;border-radius:0}button{cursor:pointer;white-space:nowrap}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.45;cursor:default}.migration-result{border:1px solid var(--gc-border-subtle);padding:14px;margin-top:14px;font-size:12px;overflow-wrap:anywhere}.migration-error{color:var(--gc-danger)}details{margin-top:10px}summary{cursor:pointer}
</style>
