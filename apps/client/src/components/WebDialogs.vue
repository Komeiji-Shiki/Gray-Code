<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, ref, watch } from 'vue';
import { webUi, browseDirectory, finishDirectory } from '../webBridge';
const typedPath = ref('');
const filter = ref('');
const directories = computed(() => webUi.directories.filter((item) => item.name.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase())));
watch(
  () => webUi.directory,
  (value) => {
    typedPath.value = value;
    filter.value = '';
  },
);
</script>
<template>
  <div v-if="webUi.chooserOpen" class="dialog-backdrop" @click.self="finishDirectory(false)">
    <section
      class="web-directory dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('uiWebDialogsChooseHostDirectory')"
      @keydown.esc.stop.prevent="finishDirectory(false)"
    >
      <header>
        <h2>{{ t('chooseFolder') }}</h2>
        <button @click="finishDirectory(false)" :aria-label="t('close')">×</button>
      </header>
      <p class="subtle">
        {{ t('uiWebDialogsBrowsingHostDevice') }}
        <strong>{{ webUi.directoryDevice }}</strong>
      </p>
      <nav class="web-directory-roots" :aria-label="t('uiWebDialogsDeviceDisks')">
        <button v-for="root in webUi.directoryRoots" :key="root.path" :disabled="webUi.directoryBusy" @click="browseDirectory(root.path)">
          {{ root.name }}
        </button>
      </nav>
      <form class="web-path" @submit.prevent="browseDirectory(typedPath)">
        <input v-model="typedPath" :aria-label="t('uiWebDialogsDirectoryPath')" :placeholder="t('uiWebDialogsHostPathPlaceholder')" />
        <button :disabled="webUi.directoryBusy">{{ t('uiBrowserPaneOpen') }}</button>
      </form>
      <p v-if="webUi.directoryError" role="alert" class="web-error">{{ webUi.directoryError }}</p>
      <nav class="web-directory-roots" :aria-label="t('uiWebDialogsCurrentDirectoryPath')">
        <button v-for="part in webUi.directoryBreadcrumbs" :key="part.path" :disabled="webUi.directoryBusy" @click="browseDirectory(part.path)">
          {{ part.name }}
        </button>
      </nav>
      <input
        v-model="filter"
        class="web-directory-filter"
        type="search"
        :aria-label="t('uiWebDialogsFilterFolders')"
        :placeholder="t('uiWebDialogsFilterFolders')"
        :disabled="webUi.directoryBusy"
      />
      <div class="web-directory-list">
        <button v-if="webUi.parent !== webUi.directory" :disabled="webUi.directoryBusy" @click="browseDirectory(webUi.parent)">
          {{ t('uiWebDialogsParentDirectory') }}
        </button>
        <button v-for="directory in directories" :key="directory.path" :disabled="webUi.directoryBusy" @click="browseDirectory(directory.path)">
          <span>▱</span>
          {{ directory.name }}
        </button>
        <p v-if="!webUi.directoryBusy && !directories.length" class="subtle">
          {{ filter ? t('uiWebDialogsNoMatchingFolders') : t('uiWebDialogsNoSubfoldersHelp') }}
        </p>
      </div>
      <footer>
        <span>{{ webUi.directoryBusy ? t('uiComputerPaneLoading') : webUi.directory }}</span>
        <button @click="finishDirectory(false)">{{ t('uiBrowserPaneCancel') }}</button>
        <button class="primary" :disabled="webUi.directoryBusy || !!webUi.directoryError || !webUi.directory" @click="finishDirectory(true)">
          {{ t('uiWebDialogsSelectDirectory') }}
        </button>
      </footer>
    </section>
  </div>
  <div v-if="webUi.previewUrl" class="dialog-backdrop web-preview-backdrop">
    <section class="web-preview" role="dialog" :aria-label="t('uiWebDialogsHtmlPreview')">
      <header>
        <strong>{{ t('uiWebDialogsHtmlPreview') }}</strong>
        <button @click="webUi.previewUrl = ''">{{ t('close') }}</button>
      </header>
      <iframe :src="webUi.previewUrl" :title="t('uiWebDialogsProjectHtmlPreview')" sandbox="allow-scripts"></iframe>
    </section>
  </div>
</template>
<style scoped>
.web-directory-roots {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0;
}
.web-directory-roots button {
  padding: 5px 9px;
  border-radius: var(--gc-radius-sm);
}
.web-directory {
  overflow: auto;
}
.web-directory-filter {
  box-sizing: border-box;
  width: 100%;
  padding: 9px 10px;
  min-width: 0;
  border-radius: var(--gc-radius-sm);
}
.web-directory-list {
  overflow-wrap: anywhere;
}
.web-directory-roots button {
  max-width: 100%;
  overflow-wrap: anywhere;
}
.web-directory h2 {
  font-size: 18px;
}
.web-directory footer {
  flex-wrap: wrap;
  gap: 8px;
}
.web-directory {
  width: min(680px, calc(100vw - 36px));
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}
.web-directory header,
.web-directory footer,
.web-path,
.web-preview header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.web-directory h2,
.web-directory footer > span,
.web-preview strong {
  flex: 1;
}
.web-path input {
  flex: 1;
  min-width: 0;
  padding: 10px;
}
.web-directory-list {
  overflow: auto;
  min-height: 180px;
  max-height: 45vh;
  margin: 16px 0;
  border-block: 1px solid var(--gc-border-subtle);
  padding: 8px 0;
}
.web-directory-list button {
  display: flex;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 10px;
  border: 0;
  background: transparent;
}
.web-directory-list button:hover {
  background: var(--gc-surface-sunken);
}
.web-directory footer > span {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.web-error {
  color: var(--gc-danger);
}
.web-preview {
  display: flex;
  flex-direction: column;
  width: 94vw;
  height: 90vh;
  background: var(--gc-surface-sunken);
  border: 1px solid var(--gc-border-subtle);
}
.web-preview header {
  padding: 12px 16px;
}
.web-preview iframe {
  flex: 1;
  border: 0;
  width: 100%;
  background: white;
}
.web-preview-backdrop {
  z-index: 9000;
}
.web-directory footer > span {
  min-width: 0;
  flex: 1 0 100%;
}
@media (max-width: 600px) {
  .web-directory-roots button {
    min-height: 36px;
  }
  .web-directory-list button {
    min-height: 44px;
  }
  .web-directory-list {
    min-height: 110px;
  }
  .web-directory.dialog {
    padding: 16px;
  }
  .web-directory footer button {
    flex: 1;
    min-height: 40px;
  }
}
</style>
