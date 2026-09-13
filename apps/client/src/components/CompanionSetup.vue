<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CompanionConfiguration } from '@graycode/contracts';
import { call } from '../api';

const props = defineProps<{ conversationId?: string }>();
const emit = defineEmits<{ close: []; applied: [conversationId: string]; memory: []; reminders: [] }>();
const dialog = ref<HTMLDialogElement>();
const conversationId = props.conversationId;
const form = reactive<CompanionConfiguration>({ enabled: false, name: '', userName: '', tone: '' });
const cards = ref<{ id: string; name: string }[]>([]);
const title = ref('');
const metadataToken = ref<string>();
const defaultsRevision = ref<number | null>(null);
const hasDefaults = ref(false);
const saveAsDefault = ref(false);
const ready = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const confirmLeave = ref(false);
let saved = '';
const dirty = computed(() => ready.value && (JSON.stringify(form) !== saved || saveAsDefault.value));
function requestClose() { if (busy.value) return; if (dirty.value) confirmLeave.value = true; else emit('close'); }
async function save() {
  busy.value = true; error.value = '';
  try {
    const result = await call<{ conversationId: string }>('companion.save', { conversationId, configuration: form, metadataToken: metadataToken.value, defaultsRevision: defaultsRevision.value, saveAsDefault: saveAsDefault.value });
    emit('applied', result.conversationId); emit('close');
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function clearDefaults() {
  busy.value = true; error.value = '';
  try {
    await call('companion.defaults.clear', { defaultsRevision: defaultsRevision.value });
    defaultsRevision.value = null; hasDefaults.value = false; notice.value = '已清除新对话默认配置，当前对话保持原有配置。';
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  dialog.value?.showModal(); busy.value = true;
  try {
    const value = await call<{ configuration: CompanionConfiguration; title?: string; metadataToken?: string; defaultsRevision: number | null; hasDefaults: boolean; characters: typeof cards.value }>('companion.get', { conversationId });
    Object.assign(form, value.configuration); cards.value = value.characters; title.value = value.title ?? '';
    metadataToken.value = value.metadataToken; defaultsRevision.value = value.defaultsRevision; hasDefaults.value = value.hasDefaults;
    saved = JSON.stringify(form); ready.value = true;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
});
</script>

<template>
  <dialog ref="dialog" class="companion-setup" aria-labelledby="companion-title" @cancel.prevent="requestClose">
    <header><div><h2 id="companion-title">陪伴配置</h2><p>{{ title || '开始一段新的对话' }}</p></div><button :disabled="busy" @click="requestClose">关闭</button></header>
    <form @submit.prevent="save">
      <p v-if="error" class="companion-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="ready">
        <label class="companion-check"><input v-model="form.enabled" type="checkbox">在这段对话中使用陪伴配置</label>
        <p>偏好、经历与约定使用当前账号的真实个人记忆。已有的工作区和工具配置继续生效。</p>
        <label>角色语气<select v-model="form.characterId"><option :value="undefined">使用下方填写的名称和交流偏好</option><option v-for="card in cards" :key="card.id" :value="card.id">{{ card.name }}</option></select><small>角色卡只提供名称与性格，不带入剧情、世界书、开场白或正则。</small></label>
        <div class="companion-names"><label>陪伴角色名称<input v-model="form.name" maxlength="100" placeholder="留空时使用角色卡名称"></label><label>对你的称呼<input v-model="form.userName" maxlength="100" placeholder="按你希望的方式称呼"></label></div>
        <label>交流偏好<textarea v-model="form.tone" rows="5" maxlength="4000" placeholder="例如：自然轻松地交流，记住我明确说过的约定；讨论项目时保持清楚具体。"></textarea></label>
        <div class="companion-links"><button type="button" @click="emit('memory')">查看与纠正长期记忆</button><button type="button" @click="emit('reminders')">定时提醒与自动任务</button></div>
        <p>自动提取可在长期记忆页配置或关闭。提醒按定时任务设置执行，声音和系统通知遵循「设置 → 通知系统」里的免打扰。</p>
        <label class="companion-check"><input v-model="saveAsDefault" type="checkbox">同时保存为以后新建对话的默认配置</label>
        <small>未勾选时保留已有默认配置。此配置不用于代码模式、角色模式、Bot 共享频道或其他账号。</small>
        <button v-if="hasDefaults" class="companion-clear" type="button" :disabled="busy" @click="clearDefaults">清除新对话默认配置</button>
        <footer><span v-if="dirty">有未保存的更改</span><button class="primary" type="submit" :disabled="busy">{{ busy ? '正在保存…' : conversationId ? '保存当前对话' : '用此配置新建对话' }}</button></footer>
      </template><p v-else-if="busy">正在读取配置…</p>
    </form>
    <section v-if="confirmLeave" class="companion-leave" role="alert"><p>陪伴配置还没有保存。</p><button @click="confirmLeave = false">保留编辑</button><button @click="emit('close')">放弃并关闭</button></section>
  </dialog>
</template>

<style scoped>
.companion-setup { width: min(660px, calc(100vw - 24px)); max-height: calc(100dvh - 56px); padding: 0; margin: auto; box-sizing: border-box; border: 1px solid var(--border); border-radius: 0; color: var(--text); background: var(--background); }
.companion-setup::backdrop { background: #0008; } header { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); background: var(--background); z-index: 1; } h2 { font-size: 17px; margin: 0; } header p { margin: 5px 0 0; }
form { padding: 20px; } p, small { font-size: 12px; line-height: 1.7; color: var(--muted); } label { display: flex; flex-direction: column; gap: 8px; margin-bottom: 17px; min-width: 0; } .companion-check { flex-direction: row; align-items: center; margin-bottom: 10px; } .companion-names { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
input, select, textarea, button { font: inherit; color: var(--text); border: 1px solid var(--border); border-radius: 0; background: var(--surface); padding: 8px 10px; min-width: 0; box-sizing: border-box; } button { cursor: pointer; } button:disabled { cursor: default; opacity: .6; } textarea { resize: vertical; } .companion-links { display: flex; gap: 10px; flex-wrap: wrap; } .companion-clear { display: block; margin-top: 12px; }
footer { display: flex; gap: 12px; justify-content: flex-end; align-items: center; margin-top: 22px; } footer span { color: var(--muted); font-size: 12px; } .primary { background: var(--accent); color: #101216; } .companion-error { color: #e08c8c; } .companion-leave { position: sticky; bottom: 0; background: var(--panel); border-top: 1px solid var(--border); padding: 16px 20px; } .companion-leave button + button { margin-left: 10px; }
@media (max-width: 540px) { .companion-names { grid-template-columns: 1fr; gap: 0; } form { padding: 15px; } .companion-setup { max-height: calc(100dvh - 20px); } }
</style>
