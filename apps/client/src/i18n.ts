import translations from './i18n.generated';
import { ref } from 'vue';
const language = ref(navigator.language);
export function setShellLanguage(value: string): void { language.value = value; }

export function shellText(key: keyof typeof translations.en): string {
  const selected = language.value;
  const locale = selected.startsWith('zh') ? 'zh-CN' : selected.startsWith('ja') ? 'ja' : 'en';
  return translations[locale][key];
}
