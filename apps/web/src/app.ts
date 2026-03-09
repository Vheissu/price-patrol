import { IRouter, route } from "@aurelia/router";
import { customElement, resolve } from "aurelia";
import template from "./app.html?raw";

@route({
  routes: [
    {
      path: ["", "compare"],
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
      redirectTo: "compare"
    }
  ]
})
@customElement({ name: "price-patrol-app", template })
export class PricePatrolApp {
  private readonly router = resolve(IRouter);

  readonly navigation = [
    { label: "Compare", route: "/compare", eyebrow: "Single item" },
    { label: "Basket", route: "/basket", eyebrow: "Whole trolley" },
    { label: "Lists", route: "/lists", eyebrow: "Saved plans" }
  ];

  readonly statusPills = [
    "Shelf price + unit price aware",
    "Retailer confidence surfaced",
    "Freshness and caveats always visible"
  ];

  navigate(route: string): void {
    void this.router.load(route);
  }
}
