import { createApp, h } from 'vue';
import PetSurface from '../components/PetSurface.vue';
import { call } from '../api';
import './floating.css';
createApp({ render: () => h(PetSurface, { surface: 'floating', onManage: () => void call('desktop.pet.manage'), onOpen: (id: string) => void call('desktop.pet.openConversation', { conversationId: id }) }) }).mount('#app');
