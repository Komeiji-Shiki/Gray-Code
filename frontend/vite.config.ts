import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  base: './',
  plugins: [vue()],
  // 仅本地开发使用：允许 VS Code webview(vscode-webview://...) 跨域加载 Vite 资源
  // 不允许任意 origin：防止本机其他网页/进程读取 dev server 内容
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: {
      origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^vscode-webview:\/\//],
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['*']
    }
  },
  build: {
    outDir: 'dist',
    // 还原默认警告阈值（旧值 2500KB 会掩盖入口体积膨胀），
    // 懒加载面板拆包后入口应显著小于该阈值
    chunkSizeWarningLimit: 1000,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'index.css';
          }
          return 'assets/[name][extname]';
        },
        // 大体积静态依赖拆出独立 chunk，缩小主入口（graycode:// 协议与 VS Code webview
        // 均按相对路径加载 assets/ 下的 chunk，mtime 缓存已覆盖）
        manualChunks(id) {
          if (id.includes('node_modules/js-tiktoken') || id.includes('node_modules/tiktoken')) {
            return 'vendor-tiktoken';
          }
          if (id.includes('node_modules/vue') || id.includes('node_modules/@vue') || id.includes('node_modules/pinia')) {
            return 'vendor-vue';
          }
          if (id.includes('node_modules/highlight.js')) {
            return 'vendor-highlight';
          }
          if (id.includes('node_modules/katex') || id.includes('node_modules/markdown-it')) {
            return 'vendor-markdown';
          }
          // mermaid/cytoscape 保持 Vite 原生动态 import 分包（modulepreload 不会提前拉取）
          return undefined;
        }
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  }
});