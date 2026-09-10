<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { CharacterChatConfig, CharacterResource } from '@graycode/contracts';
import { call } from '../api';
import { state } from '../state';
const props = defineProps<{ characterId?: string }>();
const emit = defineEmits<{ close: [] }>();
const resources = ref<Pick<CharacterResource, 'id' | 'name' | 'kind'>[]>([]);
const characterId = ref(props.characterId ?? '');
const userName = ref('');
const persona = ref('');
const worldbookIds = ref<string[]>([]);
const regexIds = ref<string[]>([]);
const scanDepth = ref<number | ''>(2);
const greetings = ref<string[]>([]);
const greetingIndex = ref(0);
const recursiveScan = ref('');
const maxRecursionSteps = ref<number | ''>('');
let greetingEpoch = 0;
const tokenBudget = ref<number | ''>('');
const metadataToken = ref('');
const canSave = ref(false);
const busy = ref(false);
const error = ref('');
const rpc = <T,>(type: string, data: Record<string, unknown> = {}) => call<T>('ui.request', { type, data });
async function save(create: boolean) {
  busy.value = true; error.value = '';
  try {
    if (scanDepth.value === '') throw new Error('请填写关键词扫描范围。');
    const config: CharacterChatConfig = { kind: 'character', characterId: characterId.value || undefined, greetingIndex: greetingIndex.value, userName: userName.value,
      persona: persona.value, worldbookIds: worldbookIds.value, regexIds: regexIds.value, scanDepth: Number(scanDepth.value),
      worldTokenBudget: tokenBudget.value === '' ? undefined : Number(tokenBudget.value),
      recursiveScan: recursiveScan.value === '' ? undefined : recursiveScan.value === 'true', maxRecursionSteps: maxRecursionSteps.value === '' ? undefined : Number(maxRecursionSteps.value) };
    const result = await rpc<{ conversationId?: string }>(create ? 'characters.conversation.create' : 'characters.conversation.save',
      { config, conversationId: state.conversationId, metadataToken: metadataToken.value });
    if (result.conversationId) {
      state.mode = 'character'; state.chatFocused = true;
      await call('ui.command', { command: 'platform.openModeConversation', data: result });
    }
    emit('close');
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
watch(characterId, async id => {
  const epoch = ++greetingEpoch;
  greetings.value = [];
  if (!id) return;
  try {
    const result = await rpc<{ greetings: string[] }>('characters.definition', { id });
    if (epoch !== greetingEpoch) return;
    greetings.value = result.greetings;
    if (greetingIndex.value >= result.greetings.length) greetingIndex.value = 0;
  } catch (cause) { if (epoch === greetingEpoch) error.value = (cause as Error).message; }
}, { immediate: true });
onMounted(async () => {
  busy.value = true;
  try {
    resources.value = await rpc('characters.list');
    if (state.conversationId && !props.characterId) {
      const result = await rpc<{ config: CharacterChatConfig | null; metadataToken: string; mode: unknown }>('characters.conversation.get', { conversationId: state.conversationId });
      metadataToken.value = result.metadataToken; canSave.value = result.mode === 'character';
      if (result.config) {
        characterId.value = result.config.characterId ?? ''; userName.value = result.config.userName; persona.value = result.config.persona;
        worldbookIds.value = [...result.config.worldbookIds]; regexIds.value = [...result.config.regexIds];
        scanDepth.value = result.config.scanDepth; tokenBudget.value = result.config.worldTokenBudget ?? '';
        greetingIndex.value = result.config.greetingIndex ?? 0; recursiveScan.value = result.config.recursiveScan === undefined ? '' : String(result.config.recursiveScan); maxRecursionSteps.value = result.config.maxRecursionSteps ?? '';
      }
    }
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
});
</script>
<template>
  <section class="character-setup" aria-label="角色对话配置"><header><strong>角色对话</strong><button @click="emit('close')">关闭</button></header>
    <div class="character-form"><p v-if="error" class="character-error">{{ error }}</p>
      <label>角色卡<select v-model="characterId"><option value="">不绑定角色卡</option><option v-for="resource in resources.filter(item => item.kind === 'character')" :key="resource.id" :value="resource.id">{{ resource.name }}</option></select></label>
      <label v-if="greetings.length">新会话开场白<select v-model="greetingIndex"><option :value="-1">不添加开场白</option><option v-for="(greeting, index) in greetings" :key="index" :value="index">{{ index + 1 }} · {{ greeting.slice(0, 70) || '（空开场）' }}</option></select></label>
      <label>用户角色名称<input v-model="userName" placeholder="{{user}} 使用的名称"></label>
      <label>用户角色设定<textarea v-model="persona" rows="4" placeholder="仅用于这段角色对话，不写入工程长期记忆"></textarea></label>
      <fieldset><legend>额外世界书</legend><label v-for="book in resources.filter(item => item.kind === 'worldbook')" :key="book.id" class="check"><input v-model="worldbookIds" type="checkbox" :value="book.id">{{ book.name }}</label><p>角色卡绑定的世界书也会参与；此处可为当前会话追加。</p></fieldset>
      <fieldset><legend>额外正则</legend><label v-for="regex in resources.filter(item => item.kind === 'regex')" :key="regex.id" class="check"><input v-model="regexIds" type="checkbox" :value="regex.id">{{ regex.name }}</label></fieldset>
      <div class="number-fields"><label>默认关键词扫描范围<input v-model="scanDepth" type="number" min="0" step="1"><small>最近几条消息，条目自带范围优先</small></label><label>世界书最大注入 Token<input v-model="tokenBudget" type="number" min="0" step="1" placeholder="由用户填写"><small>0 表示不注入；未填写时不设置默认预算</small></label></div>
      <details><summary>高级世界书设置</summary><label>递归扫描<select v-model="recursiveScan"><option value="">使用世界书文件中的配置</option><option value="true">启用</option><option value="false">关闭</option></select></label><label>最大扫描次数<input v-model="maxRecursionSteps" type="number" min="0" step="1" placeholder="0 表示由条目数与预算限制"></label></details>
      <p>预设与工具在「设置 → 工具 → 模式预设与工具」中分别绑定。角色卡和世界书只在预设引用的位置加入请求。</p>
      <footer><button v-if="canSave" :disabled="busy" @click="save(false)">保存到当前角色对话</button><button :disabled="busy" @click="save(true)">新建角色对话</button></footer>
    </div>
  </section>
</template>
<style scoped>
.character-setup{position:fixed;inset:60px max(14px,calc((100vw - 720px)/2)) 38px;z-index:70;display:flex;flex-direction:column;background:var(--background,#15171b);border:1px solid var(--border);color:var(--text);box-shadow:0 16px 60px #0008}.character-setup>header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--border)}.character-form{overflow:auto;padding:20px}.character-form label{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}.character-setup input,.character-setup select,.character-setup textarea,.character-setup button{border-radius:0;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;padding:8px 10px}.character-setup button{cursor:pointer}.character-setup fieldset{border:1px solid var(--border);margin-bottom:20px;padding:16px}.character-form .check{flex-direction:row;align-items:center}.character-form p,.character-form small{font-size:12px;line-height:1.7;color:var(--muted)}.number-fields{display:grid;grid-template-columns:1fr 1fr;gap:20px}.character-form footer{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}.character-form .character-error{color:#df7474}@media(max-width:600px){.character-setup{inset:80px 6px 30px}.number-fields{grid-template-columns:1fr}}
</style>
