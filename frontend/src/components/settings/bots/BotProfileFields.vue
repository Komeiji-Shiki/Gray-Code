<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AppSettings, BotEnvironmentEntry, BotOutputSettings, DiscordReplyProfile } from '../../../../../packages/contracts/src/settings';
import type { CharacterChatConfig, CharacterResource } from '../../../../../packages/contracts/src/characters';
import { sendToExtension } from '../../../utils/vscode';
import BotOutputFields from './BotOutputFields.vue';
import BotConversationFields from './BotConversationFields.vue';
import { useI18n } from '../../../i18n';
const { t } = useI18n();
const props = defineProps<{
  modelValue: DiscordReplyProfile; inherited: DiscordReplyProfile; settings: AppSettings;
  modes: Array<{ id: string; name: string }>; resources: Pick<CharacterResource, 'id' | 'name' | 'kind'>[];
  output: BotOutputSettings; allowStreaming?: boolean; allowForward?: boolean; defaultEnvironment?: BotEnvironmentEntry;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: DiscordReplyProfile] }>();
const effective = computed(() => ({ ...props.inherited, ...props.modelValue }));
const inheritedOutput = computed<BotOutputSettings>(() => {
  const output = { ...props.output, ...props.inherited.output };
  // 回复配置由两种 Bot 共用，只继承当前平台支持的发送方式。
  return { ...output, longReplies: output.longReplies === 'forward' && !props.allowForward ? 'split' : output.longReplies };
});
const agent = computed(() => props.settings.agents.find(item => item.id === effective.value.agentId));
const provider = computed(() => props.settings.providers.find(item => item.id === (effective.value.providerId ?? agent.value?.providerId)));
const characterMode = computed(() => props.modelValue.character === undefined ? 'inherit' : props.modelValue.character === null ? 'none' : 'custom');
const character = computed(() => props.modelValue.character);
const greetings = ref<string[]>([]);
const greetingError = ref('');
function set<K extends keyof DiscordReplyProfile>(key: K, value: DiscordReplyProfile[K]) {
  const next = { ...props.modelValue }; if (value === undefined) delete next[key]; else next[key] = value;
  emit('update:modelValue', next);
}
function setProvider(value: string) {
  const next = { ...props.modelValue }; delete next.modelId;
  if (value) next.providerId = value; else delete next.providerId;
  emit('update:modelValue', next);
}
function chooseCharacterMode(value: string) {
  set('character', value === 'inherit' ? undefined : value === 'none' ? null : JSON.parse(JSON.stringify(effective.value.character ?? {
    kind: 'character', userName: '', persona: '', worldbookIds: [], regexIds: [], scanDepth: 2, greetingIndex: 0,
  })));
}
function setCharacter<K extends keyof CharacterChatConfig>(key: K, value: CharacterChatConfig[K]) {
  if (character.value) set('character', { ...character.value, [key]: value });
}
function toggleResource(key: 'worldbookIds' | 'regexIds', id: string, checked: boolean) {
  const values = character.value?.[key] ?? [];
  setCharacter(key, checked ? [...values, id] : values.filter(value => value !== id));
}
watch(() => character.value?.characterId, async (id, _previous, onCleanup) => {
  let current = true; onCleanup(() => { current = false; }); greetings.value = []; greetingError.value = '';
  if (!id) return;
  try { const result = await sendToExtension<{ greetings: string[] }>('characters.definition', { id }); if (current) greetings.value = result.greetings; }
  catch (error) { if (current) greetingError.value = (error as Error).message; }
}, { immediate: true });
</script>
<template>
  <div class="bot-fields">
    <label><span>智能体</span><select :value="modelValue.agentId ?? ''" @change="set('agentId', ($event.target as HTMLSelectElement).value || undefined)"><option value="">继承 · {{ settings.agents.find(item => item.id === inherited.agentId)?.name || '默认智能体' }}</option><option v-for="item in settings.agents" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label><span>模型渠道</span><select :value="modelValue.providerId ?? ''" @change="setProvider(($event.target as HTMLSelectElement).value)"><option value="">继承默认渠道</option><option v-for="item in settings.providers" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label><span>模型<small>{{ provider?.name || '请先为智能体配置模型渠道' }}</small></span><select :value="modelValue.modelId ?? ''" @change="set('modelId', ($event.target as HTMLSelectElement).value || undefined)"><option value="">使用默认模型</option><option v-for="item in provider?.models ?? []" :key="item.id" :value="item.id">{{ item.name || item.id }}</option><option v-if="modelValue.modelId && !provider?.models.some(item => item.id === modelValue.modelId)" :value="modelValue.modelId">{{ modelValue.modelId }}（已保存）</option></select></label>
    <label><span>提示词预设</span><select :value="modelValue.promptModeId ?? ''" @change="set('promptModeId', ($event.target as HTMLSelectElement).value || undefined)"><option value="">继承默认预设</option><option v-for="item in modes" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label><span>后续任务的工作区<small>保持会话历史，已经运行的任务使用原目录。</small></span><select :value="modelValue.workspaceId === null ? '@none' : modelValue.workspaceId ?? ''" @change="set('workspaceId', ($event.target as HTMLSelectElement).value === '@none' ? null : ($event.target as HTMLSelectElement).value || undefined)"><option value="">继承配置或使用会话独立目录</option><option value="@none">不绑定工作区</option><option v-for="item in settings.workspaces" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label><span>工具调用<small>启用后仍受账号权限与工具审批规则限制。</small></span><select :value="modelValue.toolsEnabled === undefined ? '' : String(modelValue.toolsEnabled)" @change="set('toolsEnabled', ($event.target as HTMLSelectElement).value === '' ? undefined : ($event.target as HTMLSelectElement).value === 'true')"><option value="">继承默认配置</option><option value="true">允许智能体已配置的工具</option><option value="false">关闭工具，仅聊天</option></select></label>
    <label><span>每轮工具迭代上限<small>留空继承；填写正整数或 -1（不限制），0 无效。每次模型生成计一轮，同一轮可以调用多个工具。较低上限适合简单问答，复杂任务可能在完成前达到上限；调高允许更多轮请求。</small></span><input type="number" min="-1" step="1" :value="modelValue.maxIterations ?? ''" placeholder="继承默认配置" @change="set('maxIterations', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))" /></label>
    <label><span>新对话的角色配置<small>角色卡、世界书和正则来自共享资料库。</small></span><select :value="characterMode" @change="chooseCharacterMode(($event.target as HTMLSelectElement).value)"><option value="inherit">继承默认角色配置</option><option value="none">普通对话，不使用角色配置</option><option value="custom">单独配置角色与世界书</option></select></label>
    <div v-if="character" class="bot-inset">
      <label><span>角色卡</span><select :value="character.characterId ?? ''" @change="set('character', { ...character, characterId: ($event.target as HTMLSelectElement).value || undefined, greetingIndex: 0 })"><option value="">仅使用世界书与正则</option><option v-for="item in resources.filter(item => item.kind === 'character')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label v-if="greetings.length"><span>开场白</span><select :value="character.greetingIndex ?? 0" @change="setCharacter('greetingIndex', Number(($event.target as HTMLSelectElement).value))"><option :value="-1">不添加开场白</option><option v-for="(greeting, index) in greetings" :key="index" :value="index">{{ index + 1 }} · {{ greeting.slice(0, 70) || '（空开场白）' }}</option></select></label>
      <p v-if="greetingError" class="bot-error">{{ greetingError }}</p>
      <label><span>对话中的用户名称</span><input :value="character.userName" @input="setCharacter('userName', ($event.target as HTMLInputElement).value)" /></label>
      <label><span>用户设定</span><textarea rows="3" :value="character.persona" @input="setCharacter('persona', ($event.target as HTMLTextAreaElement).value)" /></label>
      <div v-for="kind in (['worldbook', 'regex'] as const)" :key="kind" class="bot-resource-row"><span>{{ kind === 'worldbook' ? '额外世界书' : '额外正则' }}</span><div class="bot-options"><label v-for="item in resources.filter(item => item.kind === kind)" :key="item.id"><input type="checkbox" :checked="character[kind === 'worldbook' ? 'worldbookIds' : 'regexIds'].includes(item.id)" @change="toggleResource(kind === 'worldbook' ? 'worldbookIds' : 'regexIds', item.id, ($event.target as HTMLInputElement).checked)" />{{ item.name }}</label><small v-if="!resources.some(item => item.kind === kind)">资料库中还没有此类资源。</small></div></div>
      <label><span>关键词扫描范围<small>扫描最近几条消息；条目或世界书自己的范围优先。0 不扫描历史消息，常驻条目与额外来源仍可参与激活。增大有助于延续较早话题，也可能命中已经转移的话题。</small></span><input type="number" min="0" step="1" :value="character.scanDepth" @change="setCharacter('scanDepth', Number(($event.target as HTMLInputElement).value))" /></label>
      <label>
        <span>世界书最大注入 Token<small>{{ t('desktop.shell.characterWorldBudgetHelp') }}</small></span>
        <input type="number" min="0" step="1" :value="character.worldTokenBudget ?? ''"
          :placeholder="t('desktop.shell.characterWorldBudgetPlaceholder')"
          @change="setCharacter('worldTokenBudget', ($event.target as HTMLInputElement).value === ''
            ? undefined : Number(($event.target as HTMLInputElement).value))" />
      </label>
    </div>
    <label><span>单独配置回复显示</span><input type="checkbox" :checked="!!modelValue.output" @change="set('output', ($event.target as HTMLInputElement).checked ? { ...inheritedOutput } : undefined)" /></label>
    <BotOutputFields v-if="modelValue.output" :model-value="modelValue.output" :inherited="inheritedOutput" :allow-streaming="allowStreaming" :allow-forward="allowForward" @update:model-value="set('output', $event)" />
    <BotConversationFields :model-value="modelValue" :inherited="inherited" :default-environment="defaultEnvironment" @update:model-value="emit('update:modelValue', $event)" />
  </div>
</template>
<style scoped>
.bot-fields>label { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 15px 0; }
.bot-fields>label>span { width: 42%; }
.bot-fields>label>input:not([type=checkbox]),.bot-fields>label>select,.bot-fields>label>textarea { width: 54%; }
.bot-fields input,.bot-fields select,.bot-fields textarea { font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); padding: 9px 10px; min-width: 0; box-sizing: border-box; }
.bot-fields input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--gc-focus-border); }
.bot-fields small { display: block; font-size: 12px; font-weight: 400; color: var(--gc-text-muted); line-height: 1.65; margin-top: 5px; }
.bot-inset { padding: 0 0 8px 18px; margin: 12px 0; }
.bot-resource-row { display: flex; gap: 24px; padding: 15px 0; } .bot-resource-row>span { width: 42%; }
.bot-options { width: 54%; display: grid; gap: 8px; } .bot-options label { display: flex; align-items: center; gap: 10px; }
.bot-error { color: var(--gc-danger); overflow-wrap: anywhere; }
@media (max-width: 650px) {
  .bot-fields>label { align-items: flex-start; flex-wrap: wrap; gap: 10px; }
  .bot-fields>label>span { width: auto; flex: 1; }
  .bot-fields>label>input:not([type=checkbox]),.bot-fields>label>select,.bot-fields>label>textarea { width: 100%; }
  .bot-resource-row { flex-direction: column; gap: 8px; }
  .bot-resource-row>span,.bot-options { width: 100%; }
}
</style>
