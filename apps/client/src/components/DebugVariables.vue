<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DebugVariable } from '@graycode/contracts';
import { debugRequest } from '../debugging';
const props = withDefaults(defineProps<{ sessionId: string; reference: number; revision: number; depth?: number }>(), { depth: 0 });
const variables = ref<DebugVariable[]>([]), expanded = ref<string[]>([]), loading = ref(false), error = ref('');
const pageSize = 100; const hasMore = ref(false); let epoch = 0;
async function load(append = false) {
  const request = ++epoch, sessionId = props.sessionId, reference = props.reference, revision = props.revision;
  loading.value = true;
  try {
    const result = await debugRequest<{ variables: DebugVariable[] }>(sessionId, 'variables', { variablesReference: reference, start: append ? variables.value.length : 0, count: pageSize });
    if (request !== epoch || sessionId !== props.sessionId || reference !== props.reference || revision !== props.revision) return;
    const previous = variables.value.length;
    // 不支持分页的适配器可能返回全部变量；去重后不再显示无效的下一页按钮。
    variables.value = append ? [...variables.value, ...result.variables.filter(item => !variables.value.some(value => value.name === item.name))] : result.variables;
    hasMore.value = result.variables.length === pageSize && (!append || variables.value.length > previous); error.value = '';
  } catch (failure) { if (request === epoch) error.value = String(failure); }
  finally { if (request === epoch) loading.value = false; }
}
watch(() => [props.sessionId, props.reference, props.revision], () => { variables.value = []; expanded.value = []; if (props.reference) void load(); }, { immediate: true });
function toggle(name: string) { expanded.value = expanded.value.includes(name) ? expanded.value.filter(value => value !== name) : [...expanded.value, name]; }
</script>
<template>
  <div class="debug-variables" :aria-busy="loading">
    <div v-for="variable in variables" :key="variable.name" class="debug-variable">
      <div class="variable-row"><button v-if="variable.variablesReference" :aria-expanded="expanded.includes(variable.name)" :aria-label="'展开变量 ' + variable.name" @click="toggle(variable.name)">{{ expanded.includes(variable.name) ? '▾' : '▸' }}</button><span v-else class="variable-spacer"></span><strong :title="variable.type">{{ variable.name }}</strong><code :title="variable.value">{{ variable.value }}</code></div>
      <DebugVariables v-if="expanded.includes(variable.name)" :session-id="sessionId" :reference="variable.variablesReference" :revision="revision" :depth="depth + 1" />
    </div>
    <p v-if="error" role="alert">{{ error }}</p><button v-if="hasMore" :disabled="loading" @click="load(true)">加载更多变量</button><span v-if="loading" class="variables-loading">读取中…</span>
  </div>
</template>
<style scoped>
.debug-variables{min-width:0;font-size:12px}.debug-variable>.debug-variables{margin-left:12px;border-left:1px solid var(--border);padding-left:4px}.variable-row{display:flex;align-items:baseline;gap:6px;min-width:0;padding:4px 0}.variable-row button,.variable-spacer{width:14px;flex-shrink:0}.variable-row strong{font-weight:500;overflow-wrap:anywhere;color:var(--accent)}code{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}button{padding:0;background:transparent;border:0;color:var(--text);cursor:pointer}.variables-loading{color:var(--muted)}p{color:var(--danger,#f08080)}
</style>
