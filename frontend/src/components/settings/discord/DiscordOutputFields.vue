<script setup lang="ts">
import { computed } from 'vue';
import type { DiscordOutputSettings } from '../../../../../packages/contracts/src/settings';
const props = defineProps<{ modelValue: Partial<DiscordOutputSettings>; inherited: DiscordOutputSettings }>();
const emit = defineEmits<{ 'update:modelValue': [value: Partial<DiscordOutputSettings>] }>();
const effective = computed(() => ({ ...props.inherited, ...props.modelValue }));
function set<K extends keyof DiscordOutputSettings>(key: K, value: DiscordOutputSettings[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
</script>
<template>
  <div class="discord-fields">
    <label><span>逐步显示回复<small>合并一段输出后更新同一条消息，结束时补齐全文。</small></span><input type="checkbox" :checked="effective.streaming" @change="set('streaming', ($event.target as HTMLInputElement).checked)" /></label>
    <label v-if="effective.streaming"><span>更新间隔<small>范围 1～60 秒，是逐步更新频道消息的最短等待时间。较小值便于及时查看进展，但消息编辑更频繁；长回复可用较大值减少更新。结束时会补齐全文，模型生成速度不受此值影响。</small></span><input type="number" min="1" max="60" step="0.1" :value="effective.updateIntervalMs / 1000" @change="set('updateIntervalMs', Math.round(Number(($event.target as HTMLInputElement).value) * 1000))" /></label>
    <label><span>显示思考内容<small>开启后，模型返回的思考内容也会发送到当前频道。</small></span><input type="checkbox" :checked="effective.showThoughts" @change="set('showThoughts', ($event.target as HTMLInputElement).checked)" /></label>
    <label v-if="effective.streaming"><span>显示工具运行状态<small>展示正在执行的工具名称，不发送工具参数。</small></span><input type="checkbox" :checked="effective.showToolStatus" @change="set('showToolStatus', ($event.target as HTMLInputElement).checked)" /></label>
    <label><span>较长回复的发送方式</span><select :value="effective.longReplies" @change="set('longReplies', ($event.target as HTMLSelectElement).value as 'split' | 'file')"><option value="split">拆成多条消息，保持代码块完整</option><option value="file">全文作为 Markdown 附件发送</option></select></label>
  </div>
</template>
