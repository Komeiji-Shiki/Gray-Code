<script setup lang="ts">
import { computed } from 'vue';
import type { BotOutputSettings } from '../../../../../packages/contracts/src/settings';
const props = defineProps<{ modelValue: Partial<BotOutputSettings>; inherited: BotOutputSettings; allowStreaming?: boolean; allowForward?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Partial<BotOutputSettings>] }>();
const allowsStreaming = computed(() => props.allowStreaming !== false);
const effective = computed(() => ({ ...props.inherited, ...props.modelValue }));
/** 合并转发不是每个平台与协议版本都支持，未启用时回落到分段发送。 */
const longReplies = computed(() => effective.value.longReplies === 'forward' && !props.allowForward ? 'split' : effective.value.longReplies);
function set<K extends keyof BotOutputSettings>(key: K, value: BotOutputSettings[K]) {
  emit('update:modelValue', { ...props.modelValue, longReplies: longReplies.value, [key]: value });
}
</script>
<template>
  <div class="bot-fields">
    <template v-if="allowsStreaming">
      <label><span>逐步显示回复<small>合并一段输出后更新同一条消息，结束时补齐全文。</small></span><input type="checkbox" :checked="effective.streaming" @change="set('streaming', ($event.target as HTMLInputElement).checked)" /></label>
      <label v-if="effective.streaming"><span>更新间隔<small>范围 1～60 秒，是逐步更新频道消息的最短等待时间。较小值便于及时查看进展，但消息编辑更频繁；长回复可用较大值减少更新。结束时会补齐全文，模型生成速度不受此值影响。</small></span><input type="number" min="1" max="60" step="0.1" :value="effective.updateIntervalMs / 1000" @change="set('updateIntervalMs', Math.round(Number(($event.target as HTMLInputElement).value) * 1000))" /></label>
    </template>
    <label><span>显示思考内容<small>开启后，模型返回的思考内容也会随回复发送。</small></span><input type="checkbox" :checked="effective.showThoughts" @change="set('showThoughts', ($event.target as HTMLInputElement).checked)" /></label>
    <label><span>显示工具运行状态<small>{{ allowsStreaming ? '展示正在执行的工具名称，不发送工具参数。' : '在每轮回复后列出本轮调用的工具，不发送工具参数。' }}</small></span><input type="checkbox" :checked="effective.showToolStatus" @change="set('showToolStatus', ($event.target as HTMLInputElement).checked)" /></label>
    <label><span>较长回复的发送方式</span><select :value="longReplies" @change="set('longReplies', ($event.target as HTMLSelectElement).value as BotOutputSettings['longReplies'])"><option value="split">拆成多条消息，保持代码块完整</option><option value="file">全文作为 Markdown 附件发送</option><option value="forward" :disabled="!allowForward">合并转发成一条聊天记录</option></select></label>
  </div>
</template>
<style scoped>
.bot-fields>label { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 15px 0; }
.bot-fields>label>span { width: 42%; }
.bot-fields>label>input:not([type=checkbox]),.bot-fields>label>select,.bot-fields>label>textarea { width: 54%; }
input,select,textarea { font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); padding: 9px 10px; min-width: 0; box-sizing: border-box; }
input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--gc-focus-border); }
small { display: block; font-size: 12px; font-weight: 400; color: var(--gc-text-muted); line-height: 1.65; margin-top: 5px; }
@media (max-width: 650px) {
  .bot-fields>label { align-items: flex-start; flex-wrap: wrap; gap: 10px; }
  .bot-fields>label>span { width: auto; flex: 1; }
  .bot-fields>label>input:not([type=checkbox]),.bot-fields>label>select,.bot-fields>label>textarea { width: 100%; }
}
</style>
