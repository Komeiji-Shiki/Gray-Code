<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ExternalAgentProfile } from '@graycode/contracts';
import { sendToExtension } from '../../utils/vscode';
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft';

const profiles = ref<Array<ExternalAgentProfile & { envText: string }>>([]);
const ready = ref(false), error = ref('');
function add(kimi = false) {
  profiles.value.push({ id: 'agent-' + crypto.randomUUID().slice(0, 8), name: kimi ? 'Kimi Code' : '编码代理', enabled: true,
    command: kimi ? 'kimi' : '', args: kimi ? ['acp'] : [], envText: '' });
  markDesktopSettingsDirty();
}
function remove(index: number) { profiles.value.splice(index, 1); markDesktopSettingsDirty(); }
async function save() {
  await sendToExtension('platform.externalAgents.update', { profiles: profiles.value.map(({ envText, ...profile }) => ({ ...profile,
    env: envText.trim() ? JSON.parse(envText) : undefined })) });
}
useDesktopSettingsDraft(save, () => ready.value);
onMounted(async () => {
  try {
    const saved = await sendToExtension<ExternalAgentProfile[]>('platform.externalAgents.get', {});
    profiles.value = saved.map(profile => ({ ...profile, args: [...profile.args], envText: profile.env ? JSON.stringify(profile.env, null, 2) : '' }));
    ready.value = true;
  } catch (cause) { error.value = (cause as Error).message; }
});
</script>
<template>
  <section class="external-agents" @input="markDesktopSettingsDirty" @change="markDesktopSettingsDirty">
    <header><h4>外部编码代理</h4><button type="button" :disabled="!ready" @click="add()">添加 ACP 代理</button><button type="button" :disabled="!ready" @click="add(true)">Kimi Code 示例</button></header>
    <p>配置支持 ACP 的本机编码代理。代理在任务的工作区启动，模型和登录状态由该代理管理；保存配置后可通过编码代理工具创建或继续会话。</p>
    <article v-for="(profile,index) in profiles" :key="profile.id">
      <div class="agent-title"><label><input v-model="profile.enabled" type="checkbox" />启用</label><input v-model="profile.name" aria-label="代理名称" /><button type="button" @click="remove(index)">移除配置</button></div>
      <label>启动命令<input v-model="profile.command" placeholder="例如 kimi，或程序的完整路径" spellcheck="false" /></label>
      <div class="arguments"><span>启动参数</span><div v-for="(_,argument) in profile.args" :key="argument"><input v-model="profile.args[argument]" :aria-label="'参数 ' + (argument+1)" spellcheck="false" /><button type="button" @click="profile.args.splice(argument,1); markDesktopSettingsDirty()">移除</button></div>
        <button type="button" @click="profile.args.push(''); markDesktopSettingsDirty()">添加参数</button></div>
      <details><summary>环境变量</summary><textarea v-model="profile.envText" rows="4" placeholder="JSON 对象；留空时继承应用环境" spellcheck="false"></textarea></details>
    </article>
    <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.external-agents{display:grid;gap:12px;border-top:1px solid var(--vscode-panel-border);padding-top:16px}.external-agents header,.agent-title,.arguments>div{display:flex;align-items:center;gap:8px}.external-agents h4{margin:0;flex:1}.external-agents p{font-size:12px;line-height:1.7;margin:0;color:var(--vscode-descriptionForeground)}article{display:grid;gap:10px;border:1px solid var(--vscode-panel-border);padding:12px}label,.arguments{display:grid;gap:6px}.agent-title label{display:flex;white-space:nowrap}.agent-title>input,.arguments input{flex:1;min-width:0}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;padding:7px}button{font:inherit;padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}.arguments>button{justify-self:start}summary{cursor:pointer;padding:5px 0}.agent-error{color:var(--vscode-errorForeground)!important}@media(max-width:600px){.external-agents header{flex-wrap:wrap}.external-agents h4{flex-basis:100%}}
</style>
