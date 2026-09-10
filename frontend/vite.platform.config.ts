import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
export default defineConfig({
  plugins: [vue()], base: './',
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@shared': path.resolve(__dirname, '../shared') } },
  build: { target: 'es2022', outDir: '../apps/client/dist/chat', emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'platform.html') } },
});
