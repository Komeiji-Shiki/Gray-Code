<script setup lang="ts">
import { ref, watch } from "vue";
import { call } from "../api";
import { guard, state } from "../state";
import { useWorkspaceRoots } from "../workspaceRoots";
const { roots, directory } = useWorkspaceRoots();
let refreshEpoch = 0;
const branch = ref("");
const entries = ref<{ path: string; index: string; worktree: string }[]>([]);
const diff = ref("");
const message = ref("");
const notice = ref("");
async function refresh() {
  const epoch = ++refreshEpoch;
  if (!state.workspaceId || !directory.value) { entries.value = []; branch.value = ""; diff.value = ""; return; }
  try {
    const value = await call("git.status", { workspaceId: state.workspaceId, directory: directory.value });
    if (epoch !== refreshEpoch) return;
    branch.value = value.branch;
    entries.value = value.entries;
    notice.value = "";
  } catch (error) {
    if (epoch !== refreshEpoch) return;
    entries.value = []; branch.value = "";
    notice.value = error instanceof Error ? error.message : String(error);
  }
}
watch(
  [() => state.workspaceId, directory],
  () => { entries.value = []; diff.value = ""; void refresh(); },
  { immediate: true },
);
async function stage(path: string, staged: boolean) {
  await call("git.stage", { workspaceId: state.workspaceId, directory: directory.value, path, staged });
  await refresh();
}
async function showDiff(path: string, staged: boolean) {
  diff.value =
    (await call("git.diff", {
      workspaceId: state.workspaceId, directory: directory.value,
      path,
      staged,
    })) || "此文件没有可显示的文本差异。";
}
async function commit() {
  await call("git.commit", {
    workspaceId: state.workspaceId, directory: directory.value,
    message: message.value,
  });
  message.value = "";
  diff.value = "";
  await refresh();
}
</script>
<template>
  <section class="git-panel">
    <header class="panel-heading">
      <span>源代码管理</span><span>{{ branch }}</span
      ><button class="icon-button" title="刷新 Git" @click="refresh">↻</button>
    </header>
    <select v-if="roots.length > 1" v-model="directory" class="git-root" aria-label="Git 目录"><option v-for="root in roots" :key="root.directory" :value="root.directory">{{ root.name }}</option></select>
    <p v-if="notice" class="empty-note">{{ notice }}</p>
    <div class="git-content">
      <div class="git-files">
        <div v-for="entry in entries" :key="entry.path" class="git-file">
          <button
            @click="
              guard(() =>
                showDiff(
                  entry.path,
                  entry.index !== ' ' && entry.index !== '?',
                ),
              )
            "
          >
            <span class="git-code">{{ entry.index }}{{ entry.worktree }}</span
            >{{ entry.path }}</button
          ><button
            :title="
              entry.index !== ' ' && entry.index !== '?' ? '取消暂存' : '暂存'
            "
            @click="
              guard(() =>
                stage(entry.path, entry.index === ' ' || entry.index === '?'),
              )
            "
          >
            {{ entry.index !== " " && entry.index !== "?" ? "−" : "＋" }}
          </button>
        </div>
        <div v-if="!entries.length && !notice" class="empty-note">
          工作区没有未提交的修改。
        </div>
        <textarea v-model="message" placeholder="提交说明" rows="3"></textarea
        ><button
          class="primary"
          :disabled="!message.trim()"
          @click="guard(commit)"
        >
          提交已暂存的修改
        </button>
      </div>
      <pre class="git-diff">{{ diff || "选择文件查看差异。" }}</pre>
    </div>
  </section>
</template>

<style scoped>
.git-root{margin:10px 12px;width:calc(100% - 24px);padding:7px 10px;min-width:0}
</style>
