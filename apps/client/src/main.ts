import { createApp } from "vue";
import App from './Bootstrap.vue';
import { resolveAppearancePalette } from '../../../shared/appearance';
import { appearanceCssVariables } from '../../../shared/appearanceTokens';
import { preloadShellLanguage } from './i18n';
// 外壳与聊天共用同一份语义 token；色值由 shared/appearanceTokens.ts 写入根元素。
import "../../../frontend/src/styles/tokens.css";
import "./style.css";
// 语言和主题设置读取前也使用共享默认色板，避免维护另一套启动颜色。
const bootstrapPalette = appearanceCssVariables(resolveAppearancePalette('dark', {}, false));
for (const [token, value] of Object.entries(bootstrapPalette)) document.documentElement.style.setProperty(token, value);
// 语言包加载失败不能阻止外壳挂载；shellText 会回退到键名。
void preloadShellLanguage()
  .catch(error => console.error('[Shell] 语言包加载失败：', error))
  .then(() => createApp(App).mount("#app"));
