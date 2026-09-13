<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupCategoryId, BackupRestoreSelection, PendingBackupRestore } from '@graycode/contracts'
const props = defineProps<{ pending: PendingBackupRestore; busy: boolean }>()
const emit = defineEmits<{ prepare: [selection: BackupRestoreSelection]; refresh: []; cancel: []; restart: [] }>()
const mode = ref<'' | 'complete' | 'selective'>('')
const conflictPolicy = ref<'' | 'keep' | 'replace'>('')
const selectedCategories = ref<BackupCategoryId[]>([])
const ready = computed(() => !!props.pending.selection || !props.pending.requiresSelection)
const restored = computed(() => props.pending.selection?.items?.filter(item => item.action === 'restore') ?? [])
const kept = computed(() => props.pending.selection?.items?.filter(item => item.action === 'keep') ?? [])
const categoryName = (id: BackupCategoryId) => props.pending.preview?.categories.find(category => category.id === id)?.name ?? id
const directoryName = (name: string) => ({ skills: '本地技能文件', 'user-skills': '用户技能文件', 'skill-resources': '导入技能资源' })[name] ?? name
watch(() => props.pending.id, () => {
  mode.value = props.pending.selection?.mode ?? ''
  selectedCategories.value = props.pending.selection?.categories?.map(category => category.id) ?? []
  conflictPolicy.value = props.pending.selection?.categories?.[0]?.conflict ?? ''
}, { immediate: true })
function prepare() {
  if (!mode.value || !props.pending.preview || mode.value === 'selective' && (!selectedCategories.value.length || !conflictPolicy.value)) return
  emit('prepare', { mode: mode.value, expectedPreview: props.pending.preview.fingerprint,
    ...(mode.value === 'selective' ? { categories: selectedCategories.value.map(id => ({ id, conflict: conflictPolicy.value as 'keep' | 'replace' })) } : {}) })
}
</script>
<template>
  <section class="restore-preview">
    <strong>{{ ready ? '最终恢复预览' : '选择恢复范围' }}</strong>
    <p>{{ new Date(pending.backupCreatedAt).toLocaleString() }} 的备份，共 {{ pending.conversations }} 个对话、{{ pending.messages }} 条消息。</p>
    <p v-if="pending.error" class="restore-error" role="alert">{{ pending.error }}</p>
    <p v-if="pending.preview?.unavailableCredentials?.length" class="restore-notice">其中 {{ pending.preview.unavailableCredentials.length }} 条连接凭据受原电脑或原应用配置保护，当前无法解密。可以选择不依赖这些凭据的类别，或在仍能解密凭据的原应用中使用密码重新导出备份。</p>
    <template v-if="pending.preview && !ready">
      <label>恢复方式<select v-model="mode" :disabled="busy" aria-label="备份恢复方式"><option value="" disabled>请选择恢复方式</option><option value="complete">完整恢复：使用备份中的全部程序数据</option><option value="selective">选择性恢复：只恢复勾选的类别</option></select></label>
      <template v-if="mode === 'selective'">
        <label>遇到已有对象时<select v-model="conflictPolicy" :disabled="busy" aria-label="备份冲突处理"><option value="" disabled>请选择处理方式</option><option value="keep">保留当前数据，导入尚不存在的对象</option><option value="replace">使用备份替换已有对象</option></select></label>
        <div class="restore-categories">
          <label v-for="category in pending.preview.categories" :key="category.id" class="restore-category" :class="{ unavailable: !category.count }">
            <input v-model="selectedCategories" type="checkbox" :value="category.id" :disabled="busy || !category.count" :aria-label="'恢复类别：' + category.name" />
            <span><strong>{{ category.name }}</strong><small>{{ category.count }} 个对象或目录 · {{ category.conflicts }} 个已存在</small><p>{{ category.description }}</p>
              <p v-for="dependency in category.dependencies" :key="dependency.id" class="dependency">{{ dependency.reason }}</p>
              <details v-if="category.examples.length"><summary>查看对象与冲突</summary><ul><li v-for="(item, index) in category.examples" :key="index">{{ item.name }}<span v-if="item.conflict"> · 已存在</span></li></ul><small v-if="category.count > category.examples.length">这里展示前 {{ category.examples.length }} 项，最终预览会列出本次实际恢复的范围。</small></details>
            </span>
          </label>
        </div>
      </template>
      <p v-if="mode === 'complete'">完整恢复会切换为备份中的全部程序数据。恢复前的目录完整保留，项目源码不被替换。</p>
      <p>准备恢复时会重新核对当前数据，并列出所需依赖。最终确认之前不会切换数据目录。</p>
      <button :disabled="busy || !mode || mode === 'selective' && (!selectedCategories.length || !conflictPolicy)" @click="prepare">准备恢复并查看最终预览</button>
    </template>
    <template v-else-if="ready">
      <p v-if="pending.selection?.mode === 'selective'">本次恢复 {{ restored.length }} 个对象，保留 {{ kept.length }} 个已有对象，并处理 {{ pending.selection.directories.length }} 个技能目录。未选择的数据在实际恢复时从当前库保留。</p>
      <p v-else>本次使用备份中的完整程序数据。</p>
      <ul v-if="restored.length" class="restore-items"><li v-for="(item, index) in restored" :key="index">{{ categoryName(item.category) }}：{{ item.name }}<span v-if="item.dependency">（所需依赖）</span></li></ul>
      <p v-for="directory in pending.selection?.directories" :key="directory.name">{{ directoryName(directory.name) }}：{{ directory.conflict === 'keep' ? '已有目录保持不变' : '使用备份目录替换' }}</p>
      <p v-if="pending.preview">最终核对时间：{{ new Date(pending.preview.createdAt).toLocaleString() }}。选中对象在此之后发生变化时会停止应用，返回重新预览。</p>
      <p>重启会停止当前任务和连接。恢复前的数据会保留为独立目录，当前的记忆删除和设备撤销记录继续生效。</p>
      <button :disabled="busy" class="primary" @click="emit('restart')">确认重启并恢复</button>
    </template>
    <details v-if="pending.preview?.migrations.length"><summary>版本与恢复处理</summary><p v-for="item in pending.preview.migrations" :key="item">{{ item }}</p></details>
    <div class="restore-actions"><button :disabled="busy" @click="emit('refresh')">{{ ready ? '重新选择恢复范围' : '刷新分类与冲突' }}</button><button :disabled="busy" @click="emit('cancel')">取消恢复</button></div>
  </section>
</template>
<style scoped>
.restore-preview { margin-top: 14px; padding: 14px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textBlockQuote-background); display: flex; flex-direction: column; gap: 12px; font-size: 12px; }
p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.7; overflow-wrap: anywhere; } label { display: flex; flex-direction: column; gap: 7px; } small { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
button, select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 0; padding: 8px 10px; min-width: 0; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.restore-categories { display: flex; flex-direction: column; gap: 8px; }.restore-category { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 10px; padding: 12px; border: 1px solid var(--vscode-panel-border); }.restore-category > input { margin: 2px 0 0; }.restore-category p { margin-top: 7px; }.unavailable { opacity: .5; }.dependency, .restore-notice { color: var(--vscode-editorWarning-foreground); }
details { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; } summary { cursor: pointer; } ul { padding-left: 18px; margin: 8px 0; } .restore-items { max-height: 220px; overflow: auto; }.restore-actions { display: flex; flex-wrap: wrap; gap: 8px; }.restore-error { color: var(--vscode-errorForeground); }
</style>
