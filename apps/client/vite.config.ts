import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { petRendererBuild } from './src/pets/buildPlugin';
export default defineConfig({
  plugins: [vue(), petRendererBuild()],
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        pet: new URL('./pet.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        main: new URL("./index.html", import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/,
          "$1",
        ),
        browser: new URL("./browser.html", import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/,
          "$1",
        ),
      },
    },
  },
  worker: { format: "es" },
});
