import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import 'katex/dist/katex.min.css';
import 'file-icons-js/css/style.css';
import './style.css';

// 导入工具注册
import './utils/tools';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 扩展 Webview 会先绘制极小启动壳，再并行加载完整样式与本模块。
// 等样式 Promise 完成后才让 Vue 替换启动壳，避免出现无样式组件；浏览器预览直接挂载。
async function mountApplication(): Promise<void> {
  try {
    await (window.__GRAYCODE_FRONTEND_STYLES_READY ?? Promise.resolve())
  } finally {
    app.mount('#app')
  }
}

void mountApplication();