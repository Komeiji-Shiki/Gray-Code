<script setup lang="ts">
defineProps<{ name: 'panel' | 'plus' | 'search' | 'folder' | 'pin' | 'more' | 'settings' | 'history' | 'chart' | 'chevron' | 'close' | 'chat' | 'bot' | 'file' | 'browser' | 'terminal' | 'git' | 'review' | 'warning' | 'expand' | 'restore' | 'save' | 'copy' }>();
const paths = {
  panel: 'M3 4h18v16H3z M8 4v16', plus: 'M12 4v16 M4 12h16', search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  folder: 'M3 6h7l2 3h9v11H3z', pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4z M12 15v6', more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  history: 'M3 5v5h5 M3 10a9 9 0 1 1 2 8 M12 7v5l3 2', chart: 'M4 14h3v7H4z M10 9h3v12h-3z M16 3h3v18h-3z',
  chevron: 'm8 5 7 7-7 7', close: 'm5 5 14 14 M19 5 5 19', chat: 'M3 4h18v13H9l-6 4z',
  bot: 'M4 7h16v14H4z M12 3v4 M2 11v6 M22 11v6 M8 11v3 M16 11v3 M8 17h8',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5', browser: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18',
  terminal: 'M3 4h18v16H3z M7 8l3 3-3 3 M12 16h5', git: 'M7 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M7 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M7 6v12 M18 10c0 5-11 1-11 7',
  review: 'M5 3h14v18H5z M8 8h8 M8 13h8 M12 10v6', warning: 'M12 3 2 21h20z M12 9v5 M12 17v1',
  expand: 'M14 3h7v7 M21 3l-7 7 M10 21H3v-7 M3 21l7-7', restore: 'M21 3l-7 7 M14 3v7h7 M3 21l7-7 M3 14h7v7',
  save: 'M4 3h13l4 4v14H3V3z M7 3v6h9V3 M7 21v-8h10v8', copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
};
</script>
<template><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="name === 'more' ? 3 : 1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path :d="paths[name]" /></svg></template>
