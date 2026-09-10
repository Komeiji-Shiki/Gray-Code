import { createApp, defineComponent, h, ref } from "vue";
import { call, subscribe } from "./api";
import "./browser.css";
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
