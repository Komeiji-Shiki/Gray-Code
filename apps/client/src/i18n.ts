import { computed, ref } from 'vue';
import type { ShellMessages } from './i18n.generated';

type ShellLocale = 'zh-CN' | 'en' | 'ja';
const loaders = {
  'zh-CN': () => import('./i18n/zh-CN.generated'),
  en: () => import('./i18n/en.generated'),
  ja: () => import('./i18n/ja.generated'),
};
const translations: Partial<Record<ShellLocale, ShellMessages>> = {};
const pendingLanguages = new Map<ShellLocale, Promise<void>>();
const savedLanguage = typeof localStorage === 'undefined' ? 'auto' : localStorage.getItem('graycode.language') ?? 'auto';
const language = ref(savedLanguage);
let languageRequest = 0;

function resolveLocale(value: string): ShellLocale {
  const selected = value === 'auto' ? navigator.language : value;
  return selected.startsWith('zh') ? 'zh-CN' : selected.startsWith('ja') ? 'ja' : 'en';
}

export function preloadShellLanguage(value = language.value): Promise<void> {
  const locale = resolveLocale(value);
  if (translations[locale]) return Promise.resolve();
  let loading = pendingLanguages.get(locale);
  if (!loading) {
    loading = loaders[locale]().then(module => {
      translations[locale] = module.default;
    }).finally(() => pendingLanguages.delete(locale));
    pendingLanguages.set(locale, loading);
  }
  return loading;
}

export function setShellLanguage(value: string): Promise<void> {
  const request = ++languageRequest;
  const apply = () => {
    if (request !== languageRequest) return;
    language.value = value;
    localStorage.setItem('graycode.language', value);
    document.documentElement.lang = shellLocale.value;
  };
  // 切换时继续显示当前完整语言，目标包准备好后再一次性更新所有标签。
  if (translations[resolveLocale(value)]) {
    apply();
    return Promise.resolve();
  }
  return preloadShellLanguage(value).then(apply);
}

export const shellLocale = computed(() => resolveLocale(language.value));

export function shellText(key: keyof ShellMessages, params?: Record<string, unknown>): string {
  // 按需语言包可能尚未就绪或加载失败；显示键名也比让整个外壳崩溃好。
  const value = translations[shellLocale.value]?.[key] ?? key;
  return params ? value.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : value;
}
