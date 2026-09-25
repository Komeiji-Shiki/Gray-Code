<script setup lang="ts">
import { computed } from 'vue';
import type { BotAutoSummarySettings, BotEnvironmentEntry, DiscordReplyProfile } from '../../../../../packages/contracts/src/settings';
import { DEFAULT_BOT_AUTO_SUMMARY, DEFAULT_BOT_ENVIRONMENT } from '../../../../../shared/botConversation';
const props = defineProps<{ modelValue: DiscordReplyProfile; inherited?: DiscordReplyProfile }>();
const emit = defineEmits<{ 'update:modelValue': [value: DiscordReplyProfile] }>();
const environment = computed(() => props.modelValue.environmentEntry ?? props.inherited?.environmentEntry ?? DEFAULT_BOT_ENVIRONMENT);
const summary = computed(() => props.modelValue.autoSummary ?? props.inherited?.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY);
const inheritedSummary = computed(() => props.inherited?.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY);
const summaryMode = computed(() => summary.value.method === 'notes' ? 'notes' : 'summary');
const legacyTime = computed(() => !summary.value.method || summary.value.method === 'time');
const timeEnabled = computed(() => !summary.value.method || summary.value.method === 'time' || summary.value.timedEnabled === true);
function set<K extends 'environmentEntry' | 'autoSummary'>(key: K, value: DiscordReplyProfile[K]) {
  const next = { ...props.modelValue }; if (value === undefined) delete next[key]; else next[key] = value;
  emit('update:modelValue', next);
}
function changeEnvironment(patch: Partial<BotEnvironmentEntry>) { set('environmentEntry', { ...environment.value, ...patch }); }
function normalizedSummary(): BotAutoSummarySettings {
  const current = summary.value;
  return { ...current, method: summaryMode.value, timedEnabled: timeEnabled.value };
}
function changeSummary(patch: Partial<BotAutoSummarySettings>) { set('autoSummary', { ...normalizedSummary(), ...patch }); }
function changeTiming(patch: Partial<BotAutoSummarySettings>) { set('autoSummary', { ...summary.value, ...patch }); }
</script>
<template>
  <section class="bot-conversation-fields">
    <h4>频道环境与长期会话</h4>
    <p>每个频道、群聊或私聊固定使用一个对话，空闲和更换发言人都不会自动新建。允许频道中的背景消息会保留；相邻同一人的未 @ 消息在间隔不超过五分钟时合并。</p>
    <label><span>Bot 环境条目</span><select :value="modelValue.environmentEntry ? 'custom' : 'inherit'" @change="set('environmentEntry', ($event.target as HTMLSelectElement).value === 'inherit' ? undefined : { ...environment })"><option value="inherit">继承默认条目</option><option value="custom">为这个入口单独编辑</option></select></label>
    <div class="bot-entry-editor">
      <label><span>启用频道环境</span><input type="checkbox" :checked="environment.enabled" :disabled="!modelValue.environmentEntry" @change="changeEnvironment({ enabled: ($event.target as HTMLInputElement).checked })" /></label>
      <label class="bot-full"><span>当前发言前的频道环境<small><code v-text="'{{$BOT_CONTEXT}}'"></code> 是当前平台、机器人和频道的信息，不包含工作区路径。文字会放在当轮身份和发言标记前。</small></span><textarea rows="5" :value="environment.content" :readonly="!modelValue.environmentEntry" @input="changeEnvironment({ content: ($event.target as HTMLTextAreaElement).value })" /></label>
      <label class="bot-full"><span>当轮身份说明<small><code v-text="'{{$TASK_CONTEXT}}'"></code> 是后端认证的发言身份，会放在当前 Discord 发言标记前。文字可以修改。</small></span><textarea rows="4" :value="environment.identityTemplate" :readonly="!modelValue.environmentEntry" @input="changeEnvironment({ identityTemplate: ($event.target as HTMLTextAreaElement).value })" /></label>
    </div>
    <label><span>自动总结配置</span><select :value="modelValue.autoSummary ? 'custom' : 'inherit'" @change="set('autoSummary', ($event.target as HTMLSelectElement).value === 'inherit' ? undefined : { ...summary })"><option value="inherit">继承默认配置（{{ inheritedSummary.enabled ? '已开启' : '已关闭' }}）</option><option value="custom">为这个入口单独配置</option></select></label>
    <template v-if="modelValue.autoSummary">
      <label><span>开启自动总结</span><input type="checkbox" :checked="summary.enabled" @change="changeTiming({ enabled: ($event.target as HTMLInputElement).checked })" /></label>
      <label><span>总结方式</span><select :value="summaryMode" @change="changeSummary({ method: ($event.target as HTMLSelectElement).value as 'summary' | 'notes' })"><option value="summary">普通总结 · 复用完整前缀</option><option value="notes">笔记窗口 · 按需恢复历史</option></select></label>
      <p v-if="summaryMode === 'summary'">按上下文阈值触发时，保留完整请求前缀并生成摘要；原文与附件仍可查看和恢复。</p>
      <p v-else>按上下文阈值提醒模型保存笔记并切换窗口，之后可通过笔记与历史工具恢复所需内容。</p>
      <label><span>开启时间总结<small>任务完成后，满足时间规则时执行总结。</small></span><input type="checkbox" :checked="timeEnabled" @change="changeSummary({ timedEnabled: ($event.target as HTMLInputElement).checked })" /></label>
      <template v-if="timeEnabled">
        <label><span>时间规则</span><select :value="summary.trigger" @change="changeTiming({ trigger: ($event.target as HTMLSelectElement).value as 'idle' | 'interval' })"><option value="idle">频道连续没有新消息</option><option value="interval">距上一次总结尝试已过指定时间</option></select></label>
        <label><span>间隔（分钟）<small>初始为 30 分钟，至少 1 分钟；失败后按该间隔重试。</small></span><input type="number" min="1" :value="summary.minutes" @change="changeTiming({ minutes: Number(($event.target as HTMLInputElement).value) })" /></label>
        <template v-if="legacyTime">
          <label><span>压缩前面多少内容（%）<small>按 Token 估算较早内容的压缩比例，保留最近的完整回合。</small></span><input type="number" min="1" max="99" :value="summary.percent" @change="changeTiming({ percent: Number(($event.target as HTMLInputElement).value) })" /></label>
          <label class="bot-full"><span>总结提示词<small>留空使用自动总结提示词，可指定要保留的事实与约定。</small></span><textarea rows="4" :value="summary.prompt" @input="changeTiming({ prompt: ($event.target as HTMLTextAreaElement).value })" /></label>
        </template>
      </template>
    </template>
    <p>未指定工作区时，会在用户文档目录的 graycode/discord 或 graycode/qq 下创建会话目录。模型可以使用现有文件和记忆工具维护资料，具体操作仍受当前账号权限限制。</p>
  </section>
</template>
<style scoped>
.bot-conversation-fields { border-top: 1px solid var(--gc-border-control); margin-top: 20px; padding-top: 16px; min-width: 0; }
h4 { margin: 0 0 10px; font-size: 15px; } p,small { color: var(--gc-text-muted); line-height: 1.7; } p { margin: 8px 0 12px; font-size: 12px; }
label { display: flex; align-items: center; justify-content: space-between; gap: 22px; padding: 12px 0; border-bottom: 1px solid var(--gc-border-subtle); }
label>span { flex: 1; min-width: 0; } small { display: block; font-size: 12px; margin-top: 4px; } code { color: var(--gc-text-primary); }
input,select,textarea { box-sizing: border-box; width: 52%; min-width: 0; background: var(--vscode-input-background); color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); border-radius: 0; padding: 8px 10px; font: inherit; }
select,option { color-scheme: dark; background: var(--gc-surface-raised); } input[type=checkbox] { width: auto; accent-color: var(--gc-accent-primary); }
.bot-full { display: flex; flex-direction: column; align-items: stretch; gap: 9px; } .bot-full textarea { width: 100%; resize: vertical; line-height: 1.6; } textarea[readonly] { color: var(--gc-text-muted); }
@media(max-width: 560px) { label { gap: 10px; } input,select { width: 48%; } }
</style>
