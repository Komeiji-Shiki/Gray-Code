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
app.mount('#app');