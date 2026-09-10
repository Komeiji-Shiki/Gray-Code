<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sendToExtension } from '../../utils/vscode';
interface Reviewer { id: string; name: string; reviewerProviderId?: string; reviewerToolNames?: string[] }
const agents = ref<Reviewer[]>([]);
const providers = ref<Array<{ id: string; name: string; model: string }>>([]);
const tools = ref<Array<{ name: string }>>([]);
const error = ref('');
async function save(agent: Reviewer) {
  try { error.value = ''; await sendToExtension('platform.reviewers.update', agent); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
}
function scope(agent: Reviewer, mode: string) {
  agent.reviewerToolNames = mode === 'selected' ? [] : undefined;
  void save(agent);
}
function toggle(agent: Reviewer, name: string, checked: boolean) {
  const selected = new Set(agent.reviewerToolNames); checked ? selected.add(name) : selected.delete(name);
  agent.reviewerToolNames = [...selected]; void save(agent);
}
onMounted(async () => {
  try {
    const result = await sendToExtension<{ agents: Reviewer[]; providers: typeof providers.value; tools: typeof tools.value }>('platform.reviewers.get', {});
    agents.value = result.agents; providers.value = result.providers; tools.value = result.tools;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
});
</script>
<template>
  <section class="review-settings">
    <h4>审核模型</h4><p>可完全关闭，也可仅审核指定工具。已明确需要人工确认的操作直接显示确认，不额外调用审核模型。</p>
    <div v-for="agent in agents" :key="agent.id" class="review-agent">
      <strong>{{ agent.name }}</strong>
      <label>审核模型<select v-model="agent.reviewerProviderId" @change="save(agent)"><option value="">完全关闭</option><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }} · {{ provider.model }}</option></select></label>
      <template v-if="agent.reviewerProviderId">
        <label>审核范围<select :value="agent.reviewerToolNames === undefined ? 'mutations' : 'selected'" @change="scope(agent, ($event.target as HTMLSelectElement).value)"><option value="mutations">修改、执行及其他非读取操作</option><option value="selected">仅选择的工具</option></select></label>
        <div v-if="agent.reviewerToolNames" class="review-tools"><label v-for="tool in tools" :key="tool.name"><input type="checkbox" :checked="agent.reviewerToolNames.includes(tool.name)" @change="toggle(agent, tool.name, ($event.target as HTMLInputElement).checked)" />{{ tool.name }}</label></div>
        <p v-if="agent.reviewerToolNames?.length === 0">尚未选择工具，不会发起审核请求。</p>
      </template>
    </div>
    <p v-if="error" role="alert" class="review-error">{{ error }}</p>
  </section>
</template>
<style scoped>
.review-settings{margin-top:24px;padding-top:16px;border-top:1px solid var(--vscode-panel-border)}h4{margin:0 0 8px}p{font-size:12px;line-height:1.6;color:var(--vscode-descriptionForeground)}.review-agent{padding:12px 0;display:grid;gap:10px}.review-agent>label{display:flex;align-items:center;gap:12px}select{flex:1;min-width:0;border:1px solid var(--vscode-panel-border);border-radius:0;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}.review-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px}.review-tools label{font-size:12px;display:flex;gap:6px;align-items:center}.review-error{color:var(--vscode-errorForeground)}
</style>
