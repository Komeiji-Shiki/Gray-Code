import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { getLanguage, setLanguage } from './i18n';
import 'katex/dist/katex.min.css';
import 'file-icons-js/css/style.css';
import './styles/tokens.css';
import './styles/primitives.css';
import './style.css';

// 导入工具注册
import './utils/tools';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 扩展 Webview 会先绘制极小启动壳，再并行加载完整样式与本模块。
// 等样式 Promise 完成后才让 Vue 替换启动壳，避免出现无样式组件；浏览器预览直接挂载。
async function mountApplication(): Promise<void> {
  // 独立预览入口也先准备完整语言包；平台入口已经预载时这里直接复用。
  await setLanguage(getLanguage());
  try {
    // 样式 Promise 失败不阻塞挂载：catch 吞掉拒绝，避免 unhandled rejection（finally 保证 app.mount 执行）
    await (window.__GRAYCODE_FRONTEND_STYLES_READY ?? Promise.resolve()).catch(() => {})
  } finally {
    app.mount('#app')
  }
}

void mountApplication();
