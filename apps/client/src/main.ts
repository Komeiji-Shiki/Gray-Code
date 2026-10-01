import { createApp } from "vue";
import App from './Bootstrap.vue';
// 外壳与聊天共用同一份语义 token；色值由 shared/appearanceTokens.ts 写入根元素。
import "../../../frontend/src/styles/tokens.css";
import "./style.css";
createApp(App).mount("#app");
