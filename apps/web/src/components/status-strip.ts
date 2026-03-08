import { customElement } from "aurelia";
import template from "./status-strip.html?raw";

@customElement({
  name: "status-strip",
  template,
  bindables: ["title", "state", "detail"]
})
export class StatusStrip {
  title = "";
  state: "healthy" | "degraded" | "offline" | "fresh" | "recent" | "aging" | "stale" = "healthy";
  detail = "";

  get badgeClass(): string {
    switch (this.state) {
      case "healthy":
      case "fresh":
        return "status-badge status-badge--good";
      case "degraded":
      case "recent":
      case "aging":
        return "status-badge status-badge--warn";
      default:
        return "status-badge status-badge--bad";
    }
  }
}
