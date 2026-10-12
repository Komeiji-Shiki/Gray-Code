import translations from './i18n.generated';
import { computed, ref } from 'vue';
const language = ref(navigator.language);
export function setShellLanguage(value: string): void {
  language.value = value === 'auto' ? navigator.language : value;
}

export const shellLocale = computed(() => {
  const selected = language.value;
  return selected.startsWith('zh') ? 'zh-CN' : selected.startsWith('ja') ? 'ja' : 'en';
});

export function shellText(key: keyof typeof translations.en, params?: Record<string, unknown>): string {
  const value = translations[shellLocale.value][key];
  return params ? value.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : value;
}
