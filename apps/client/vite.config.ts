import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
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
