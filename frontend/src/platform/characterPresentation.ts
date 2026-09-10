import { reactive } from 'vue';
/** 当前主聊天页的显示方式；不影响工具权限或后台任务配置。 */
export const characterPresentation = reactive({ conversationId: null as string | null, active: false });
