import { computed, onMounted, onUnmounted, ref } from 'vue';
import { appearance } from './state';
import { resolveAppearancePalette, resolveAppearanceTheme } from '../../../shared/appearance';

const systemLight = ref(false);
export const resolvedTheme = computed(() => resolveAppearanceTheme(appearance.value?.theme, systemLight.value));
export const appearancePalette = computed(() => resolveAppearancePalette(appearance.value?.theme, appearance.value?.colors, systemLight.value));

export function useSystemAppearance(): void {
  const scheme = matchMedia('(prefers-color-scheme: light)');
  const update = () => { systemLight.value = scheme.matches; };
  update();
  onMounted(() => scheme.addEventListener('change', update));
  onUnmounted(() => scheme.removeEventListener('change', update));
}
