<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps<{ text: string }>();
// Markdown 解析器只在实际打开预览时加载，不参与普通聊天和代码文件的首屏。
const markdown = new MarkdownIt({ html: false, linkify: true });
const renderedMarkdown = computed(() => markdown.render(props.text));
</script>
<template>
  <article class="markdown-preview" v-html="renderedMarkdown"></article>
</template>
