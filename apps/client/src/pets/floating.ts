import { createApp, h, onBeforeUnmount, onMounted, watchEffect } from 'vue';
import PetSurface from '../components/PetSurface.vue';
import { call, subscribe } from '../api';
import { appearance, loadSettings } from '../state';
import { appearanceSystemLight, useSystemAppearance } from '../appearance';
import { setShellLanguage } from '../i18n';
import { applyAppearanceVariables } from '../../../../shared/appearanceTokens';
import '../../../../frontend/src/styles/tokens.css';
import '../styles/base.css';
import './floating.css';

createApp({
  setup() {
    useSystemAppearance();
    watchEffect(() => {
      if (appearance.value) applyAppearanceVariables(document.documentElement, appearance.value, appearanceSystemLight.value);
    });
    let unsubscribe: (() => void) | undefined;
    const language = async () => {
      const value = await call<{ settings: { ui?: { language?: string } } }>('ui.request', { type: 'getSettings', data: {} });
      const selected = value.settings.ui?.language;
      const locale = selected && selected !== 'auto' ? selected : navigator.language;
      setShellLanguage(locale);
      document.documentElement.lang = locale;
    };
    const refresh = () => Promise.all([loadSettings(), language()]).catch(error => console.error(error));
    onMounted(() => {
      void refresh();
      unsubscribe = subscribe(event => {
        if (event.type === 'settings.changed' || event.type === 'transport.resumed') void refresh();
      });
    });
    onBeforeUnmount(() => unsubscribe?.());
    return () => h(PetSurface, {
      surface: 'floating',
      onManage: () => void call('desktop.pet.manage'),
      onOpen: (id: string) => void call('desktop.pet.openConversation', { conversationId: id }),
    });
  },
}).mount('#app');
