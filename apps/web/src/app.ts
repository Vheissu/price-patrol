import { route } from "@aurelia/router";
import { customElement } from "aurelia";
import template from "./app.html?raw";

type Theme = "light" | "dark";

@route({
  routes: [
    {
      path: ["", "today"],
      component: import("./routes/today-page"),
      title: "Today"
    },
    {
      path: "compare",
      component: import("./routes/compare-page"),
      title: "Compare"
    },
    {
      path: "basket",
      component: import("./routes/basket-page"),
      title: "Basket"
    },
    {
      path: "lists",
      component: import("./routes/lists-page"),
      title: "Lists"
    },
    {
      path: "*path",
      redirectTo: ""
    }
  ]
})
@customElement({ name: "price-patrol-app", template })
export class PricePatrolApp {
  readonly navigation = [
    { label: "Today", route: "today" },
    { label: "Compare", route: "compare" },
    { label: "Basket", route: "basket" },
    { label: "Lists", route: "lists" }
  ];

  theme: Theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";

  get themeGlyph(): string {
    return this.theme === "dark" ? "☀" : "☾";
  }

  get themeLabel(): string {
    return this.theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }

  toggleTheme(): void {
    this.theme = this.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = this.theme;
    try {
      localStorage.setItem("pp-theme", this.theme);
    } catch {
      // Storage unavailable, keep the in-memory theme.
    }
  }
}
