<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { webUi, browseDirectory, finishDirectory } from '../webBridge';
const typedPath = ref('');
const filter = ref('');
const directories = computed(() => webUi.directories.filter(item => item.name.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase())));
watch(() => webUi.directory, value => { typedPath.value = value; filter.value = ''; });
</script>
<template>
  <div v-if="webUi.chooserOpen" class="dialog-backdrop" @click.self="finishDirectory(false)">
    <section class="web-directory dialog" role="dialog" aria-modal="true" aria-label="选择部署电脑上的目录" @keydown.esc.stop.prevent="finishDirectory(false)">
      <header><h2>选择电脑文件夹</h2><button @click="finishDirectory(false)" aria-label="关闭">×</button></header>
      <p class="subtle">正在浏览运行 GrayCode 的设备：<strong>{{ webUi.directoryDevice }}</strong></p>
      <nav class="web-directory-roots" aria-label="设备磁盘"><button v-for="root in webUi.directoryRoots" :key="root.path" :disabled="webUi.directoryBusy" @click="browseDirectory(root.path)">{{ root.name }}</button></nav>
      <form class="web-path" @submit.prevent="browseDirectory(typedPath)"><input v-model="typedPath" aria-label="目录路径" placeholder="输入部署电脑上的完整路径" /><button :disabled="webUi.directoryBusy">打开</button></form>
      <p v-if="webUi.directoryError" role="alert" class="web-error">{{ webUi.directoryError }}</p>
      <nav class="web-directory-roots" aria-label="当前目录路径"><button v-for="part in webUi.directoryBreadcrumbs" :key="part.path" :disabled="webUi.directoryBusy" @click="browseDirectory(part.path)">{{ part.name }}</button></nav>
      <input v-model="filter" class="web-directory-filter" type="search" aria-label="筛选当前目录中的文件夹" placeholder="筛选当前目录中的文件夹" :disabled="webUi.directoryBusy" />
      <div class="web-directory-list"><button v-if="webUi.parent !== webUi.directory" :disabled="webUi.directoryBusy" @click="browseDirectory(webUi.parent)">↑ 上一级</button>
        <button v-for="directory in directories" :key="directory.path" :disabled="webUi.directoryBusy" @click="browseDirectory(directory.path)"><span>▱</span>{{ directory.name }}</button>
        <p v-if="!webUi.directoryBusy && !directories.length" class="subtle">{{ filter ? '没有匹配的文件夹。' : '当前目录没有子文件夹，可以直接选择。' }}</p>
      </div>
      <footer><span>{{ webUi.directoryBusy ? '正在读取…' : webUi.directory }}</span><button @click="finishDirectory(false)">取消</button><button class="primary" :disabled="webUi.directoryBusy || !!webUi.directoryError || !webUi.directory" @click="finishDirectory(true)">选择此目录</button></footer>
    </section>
  </div>
  <div v-if="webUi.previewUrl" class="dialog-backdrop web-preview-backdrop"><section class="web-preview" role="dialog" aria-label="HTML 预览">
    <header><strong>HTML 预览</strong><button @click="webUi.previewUrl = ''">关闭</button></header>
    <iframe :src="webUi.previewUrl" title="项目 HTML 预览" sandbox="allow-scripts"></iframe>
  </section></div>
</template>
<style scoped>
.web-directory-roots{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.web-directory-roots button{padding:5px 9px;border-radius:0}.web-directory{overflow:auto}
.web-directory-filter{box-sizing:border-box;width:100%;padding:9px 10px;min-width:0;border-radius:0}.web-directory-list{overflow-wrap:anywhere}.web-directory-roots button{max-width:100%;overflow-wrap:anywhere}.web-directory h2{font-size:18px}.web-directory footer{flex-wrap:wrap;gap:8px}
.web-directory{width:min(680px,calc(100vw - 36px));max-height:85vh;display:flex;flex-direction:column}.web-directory header,.web-directory footer,.web-path,.web-preview header{display:flex;align-items:center;gap:10px}.web-directory h2,.web-directory footer>span,.web-preview strong{flex:1}.web-path input{flex:1;min-width:0;padding:10px}.web-directory-list{overflow:auto;min-height:180px;max-height:45vh;margin:16px 0;border-block:1px solid var(--border);padding:8px 0}.web-directory-list button{display:flex;gap:12px;width:100%;text-align:left;padding:10px;border:0;background:transparent}.web-directory-list button:hover{background:var(--surface)}.web-directory footer>span{font-size:12px;overflow-wrap:anywhere}.web-error{color:#ee9999}.web-preview{display:flex;flex-direction:column;width:94vw;height:90vh;background:var(--surface);border:1px solid var(--border)}.web-preview header{padding:12px 16px}.web-preview iframe{flex:1;border:0;width:100%;background:white}.web-preview-backdrop{z-index:9000}
.web-directory footer>span{min-width:0;flex:1 0 100%}
@media(max-width:600px){.web-directory-roots button{min-height:36px}.web-directory-list button{min-height:44px}.web-directory-list{min-height:110px}.web-directory.dialog{padding:16px}.web-directory footer button{flex:1;min-height:40px}}
</style>
