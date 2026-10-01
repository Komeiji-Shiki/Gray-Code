import { createApp, defineComponent, h, ref } from "vue";
import type { AppearanceSettings } from "../../../packages/contracts/src/settings";
import { applyAppearanceVariables } from "../../../shared/appearanceTokens";
import { call, subscribe } from "./api";
// 启动默认值来自外壳 base.css；读取到设置后与外壳、聊天使用同一色板。
import "../../../frontend/src/styles/tokens.css";
import "./styles/base.css";
import "./browser.css";

const applyAppearance = (appearance?: AppearanceSettings) => {
  if (appearance) applyAppearanceVariables(document.documentElement, appearance, matchMedia("(prefers-color-scheme: light)").matches);
};
const loadAppearance = () => call("settings.get").then((snapshot: { settings?: { appearance?: AppearanceSettings } }) => applyAppearance(snapshot?.settings?.appearance), () => undefined);
void loadAppearance();
subscribe((event) => {
  if (event.type === "settings.changed") void loadAppearance();
  if (event.type === "ui.message" && (event as { message?: { command?: string; data?: AppearanceSettings } }).message?.command === "platform.appearance")
    applyAppearance((event as { message?: { data?: AppearanceSettings } }).message?.data);
});
createApp(
  defineComponent({
    setup() {
      const address = ref("about:blank");
      const error = ref("");
      const action = async (action: string) => {
        try {
          let url = address.value.trim();
          if (!/^[a-z-]+:/i.test(url)) url = `https://${url}`;
          await call("browser.control", { action, url });
          error.value = "";
        } catch (reason) {
          error.value =
            reason instanceof Error ? reason.message : String(reason);
        }
      };
      subscribe((event) => {
        if (event.type === "browser.navigation")
          address.value = event.url ?? "";
      });
      return () =>
        h("div", { class: "toolbar", title: error.value }, [
          ...[
            ["back", "←"],
            ["forward", "→"],
            ["reload", "↻"],
          ].map(([name, label]) =>
            h("button", { onClick: () => action(name) }, label),
          ),
          h(
            "form",
            {
              onSubmit: (event: Event) => {
                event.preventDefault();
                void action("navigate");
              },
            },
            [
              h("input", {
                value: address.value,
                "aria-label": "网址",
                onInput: (event: Event) => {
                  address.value = (event.target as HTMLInputElement).value;
                },
              }),
            ],
          ),
          h("button", { onClick: () => action("devtools") }, "DevTools"),
          error.value ? h("span", { class: "error" }, error.value) : null,
        ]);
    },
  }),
).mount("#browser-toolbar");
