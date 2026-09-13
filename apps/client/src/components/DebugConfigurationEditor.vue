<script setup lang="ts">
import { computed } from 'vue';
import type { DebugAdapterInfo, DebugConfiguration } from '@graycode/contracts';
interface Draft { configuration: DebugConfiguration; argsText: string; envText: string; optionsText: string }
const props = defineProps<{ draft: Draft; adapters: DebugAdapterInfo[]; saving: boolean }>();
const emit = defineEmits<{ save: []; remove: [] }>();
const adapter = computed(() => props.adapters.find(value => value.id === props.draft.configuration.adapterId));
</script>
<template>
  <form class="debug-configuration" @submit.prevent="emit('save')">
    <div class="configuration-fields">
      <label>配置名称<input v-model="draft.configuration.name" required aria-label="调试配置名称" /></label>
      <label>调试器<select v-model="draft.configuration.adapterId" aria-label="调试器"><option v-for="item in adapters" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>调试方式<select v-model="draft.configuration.request" aria-label="调试方式"><option value="launch">启动程序</option><option value="attach">附加到已有进程</option></select></label>
      <label v-if="draft.configuration.request === 'launch'">程序文件<input v-model="draft.configuration.program" placeholder="例如 src/main.ts、dist/main.js 或 main.py" aria-label="调试程序文件" /></label>
      <label>工作目录<input v-model="draft.configuration.cwd" placeholder="留空使用项目根目录" aria-label="调试工作目录" /></label>
      <label v-if="draft.configuration.request === 'launch'">程序输入与输出<select v-model="draft.configuration.console" aria-label="调试输入输出"><option :value="undefined">自动选择</option><option value="integratedTerminal">程序终端（支持键盘输入）</option><option value="internalConsole">调试控制台（仅输出）</option></select></label>
      <label v-if="['node', 'python'].includes(draft.configuration.adapterId)">{{ draft.configuration.adapterId === 'python' ? 'Python 解释器' : 'Node 运行程序' }}<input v-model="draft.configuration.runtimeExecutable" :placeholder="draft.configuration.adapterId === 'python' ? '可填写 .venv 中的 Python 完整路径' : '留空使用内置 Node 运行环境'" aria-label="调试运行程序" /></label>
      <template v-if="draft.configuration.request === 'attach'"><label>监听主机<input v-model="draft.configuration.host" placeholder="127.0.0.1" aria-label="调试监听主机" /></label><label>监听端口<input v-model.number="draft.configuration.port" type="number" min="1" max="65535" aria-label="调试监听端口" /></label></template>
    </div>
    <p v-if="adapter?.requirement" class="muted">{{ adapter.requirement }}</p>
    <p v-if="draft.configuration.request === 'attach'" class="muted">先让目标程序开启调试监听。Node 使用 inspector 端口，Python 使用 debugpy 端口；分离会保留原进程。</p>
    <details><summary>运行参数与高级选项</summary>
      <label>程序参数（每行一项）<textarea v-model="draft.argsText" rows="3" spellcheck="false" aria-label="调试程序参数"></textarea></label>
      <label>环境变量（每行 NAME=value，NAME 后不写等号表示移除）<textarea v-model="draft.envText" rows="3" spellcheck="false" aria-label="调试环境变量"></textarea></label>
      <label>适配器选项（JSON 对象）<textarea v-model="draft.optionsText" rows="6" spellcheck="false" aria-label="高级调试选项"></textarea></label>
      <p class="muted">例如 TypeScript 的 outFiles、sourceMaps，Python 的 module、justMyCode，或其他调试器提供的选项。</p>
    </details>
    <div class="configuration-actions"><button type="submit" :disabled="saving">保存配置</button><button type="button" :disabled="saving" @click="emit('remove')">删除此配置</button></div>
  </form>
</template>
<style scoped>
.debug-configuration{display:grid;gap:12px;padding:14px;border-bottom:1px solid var(--border)}.configuration-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}label{display:grid;gap:6px;font-size:12px}input,select,textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--border);border-radius:0;background:var(--panel);color:var(--text);padding:8px;font:inherit}textarea{font-family:var(--code-font,monospace);resize:vertical}summary{cursor:pointer;padding:7px 0}details label{margin-top:10px}.configuration-actions{display:flex;gap:8px}button{border:1px solid var(--border);border-radius:0;background:var(--panel);color:var(--text);padding:7px 12px;cursor:pointer}.muted{font-size:12px;line-height:1.65;color:var(--muted);margin:0}
</style>
