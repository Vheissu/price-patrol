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

  get dotClass(): string {
    switch (this.state) {
      case "healthy":
      case "fresh":
        return "health-dot health-dot--healthy";
      case "degraded":
      case "recent":
      case "aging":
        return "health-dot health-dot--degraded";
      default:
        return "health-dot health-dot--offline";
    }
  }
}
