import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
export default defineConfig({
  plugins: [vue()], base: './',
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, '../shared') } },
  build: { manifest: true, target: 'es2022', outDir: '../apps/client/dist/chat', emptyOutDir: true,
    rolldownOptions: { input: path.resolve(import.meta.dirname, 'platform.html') } },
});
