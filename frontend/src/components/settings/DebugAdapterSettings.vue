<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DebugAdapterDefinition, DebugAdapterInfo } from '@graycode/contracts';
import { sendToExtension } from '../../utils/vscode';
import { markDesktopSettingsDirty } from '../../platform/settingsDraft';
const props = defineProps<{ modelValue?: DebugAdapterDefinition[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: DebugAdapterDefinition[]] }>();
const adapters = ref<DebugAdapterInfo[]>([]), refreshing = ref(false), error = ref('');
async function refresh(refresh = true) {
  refreshing.value = true;
  try { adapters.value = await sendToExtension<DebugAdapterInfo[]>('platform.development.debuggers', { refresh }); error.value = ''; }
  catch (failure) { error.value = String(failure); } finally { refreshing.value = false; }
}
function add(definition?: DebugAdapterDefinition) {
  let number = 1; while (props.modelValue?.some(value => value.id === 'custom-debug-' + number)) number++;
  emit('update:modelValue', [...props.modelValue ?? [], definition ? { ...definition, args: [...definition.args] } :
    { id: 'custom-debug-' + number, name: '自定义调试器', command: '', args: [], transport: 'stdio' }]);
  markDesktopSettingsDirty();
}
function remove(index: number) { emit('update:modelValue', (props.modelValue ?? []).filter((_, position) => position !== index)); markDesktopSettingsDirty(); }
function addArgument(adapter: DebugAdapterDefinition) { adapter.args.push(''); markDesktopSettingsDirty(); }
function removeArgument(adapter: DebugAdapterDefinition, index: number) { adapter.args.splice(index, 1); markDesktopSettingsDirty(); }
onMounted(() => refresh(false));
</script>
<template>
  <section class="debug-adapter-settings" data-search-anchor="debug-adapters">
    <div class="debug-settings-heading"><h4>程序调试器</h4><button type="button" :disabled="disabled || refreshing" @click="refresh()">{{ refreshing ? '正在检测…' : '重新检测调试器' }}</button></div>
    <p>在侧边面板的「调试」中配置程序、添加断点、启动或附加会话。这里配置调试器本身的程序位置；语言补全与编译工具分别配置。</p>
    <div class="debug-service-list"><article v-for="adapter in adapters" :key="adapter.id"><strong>{{ adapter.name }}</strong><span>{{ adapter.source === 'custom' ? '使用自定义配置' : adapter.available ? adapter.source === 'bundled' ? '内置可用' : '已检测到' : '需要安装' }}</span><p>{{ adapter.requirement }}</p><a v-if="adapter.documentationUrl" :href="adapter.documentationUrl" target="_blank" rel="noopener noreferrer">安装与配置说明</a><button v-if="adapter.configurationTemplate && !modelValue?.some(value => value.id === adapter.id)" type="button" :disabled="disabled" @click="add(adapter.configurationTemplate)">设置调试器路径</button></article></div>
    <div class="debug-settings-heading"><strong>自定义调试适配器</strong><button type="button" :disabled="disabled" @click="add()">添加调试器</button></div>
    <article v-for="(adapter, index) in modelValue" :key="index" class="custom-debug-adapter">
      <div class="debug-settings-heading"><strong>{{ adapter.name }}</strong><button type="button" :disabled="disabled" @click="remove(index)">移除调试器</button></div>
      <div class="debug-adapter-fields"><label>名称<input v-model="adapter.name" :disabled="disabled" /></label><label>唯一标识<input v-model="adapter.id" :disabled="disabled" spellcheck="false" /></label><label>启动程序<input v-model="adapter.command" :disabled="disabled" placeholder="程序名称或完整路径" aria-label="调试适配器程序" spellcheck="false" /></label><label>连接方式<select v-model="adapter.transport" :disabled="disabled"><option value="stdio">标准输入输出</option><option value="tcp">TCP</option></select></label><template v-if="adapter.transport === 'tcp'"><label>监听主机<input v-model="adapter.host" :disabled="disabled" placeholder="127.0.0.1" /></label><label>监听端口<input v-model.number="adapter.port" :disabled="disabled" type="number" min="1" max="65535" /></label></template></div>
      <p v-if="adapter.transport === 'tcp'">填写适配器监听端口。启动程序留空时，连接已经运行的适配器。</p>
      <div class="debug-adapter-arguments"><div v-for="(_, argumentIndex) in adapter.args" :key="argumentIndex"><input v-model="adapter.args[argumentIndex]" :disabled="disabled" :aria-label="adapter.name + ' 启动参数 ' + (argumentIndex + 1)" spellcheck="false" /><button type="button" :disabled="disabled" @click="removeArgument(adapter, argumentIndex)">移除参数</button></div><button type="button" :disabled="disabled" @click="addArgument(adapter)">添加启动参数</button></div>
    </article>
    <p v-if="error" class="debug-settings-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.debug-adapter-settings{display:grid;gap:12px;border-top:1px solid var(--vscode-panel-border);padding-top:18px}.debug-settings-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}h4,p{margin:0}p{font-size:12px;line-height:1.7;color:var(--vscode-descriptionForeground)}.debug-service-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));border-top:1px solid var(--vscode-panel-border);border-left:1px solid var(--vscode-panel-border)}.debug-service-list article{padding:12px;display:grid;gap:7px;border-bottom:1px solid var(--vscode-panel-border);border-right:1px solid var(--vscode-panel-border);min-width:0}.debug-service-list span{font-size:11px;color:var(--vscode-descriptionForeground)}a{font-size:12px;color:var(--vscode-textLink-foreground)}.debug-service-list button{justify-self:start}.custom-debug-adapter{display:grid;gap:12px;padding:14px;border:1px solid var(--vscode-panel-border)}.debug-adapter-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}label{display:grid;gap:6px;font-size:12px}input,select{min-width:0;width:100%;box-sizing:border-box;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-panel-border);border-radius:0;font:inherit}button{border:1px solid var(--vscode-panel-border);border-radius:0;padding:5px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}.debug-adapter-arguments{display:grid;gap:8px}.debug-adapter-arguments>button{justify-self:start}.debug-adapter-arguments>div{display:flex;gap:8px}.debug-adapter-arguments input{flex:1}.debug-settings-error{color:var(--vscode-errorForeground)}
</style>
