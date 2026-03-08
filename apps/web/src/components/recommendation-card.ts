import { customElement } from "aurelia";
import template from "./recommendation-card.html?raw";
import type { RecommendationCard } from "../services/api-client";

@customElement({
  name: "recommendation-card",
  template,
  bindables: ["card", "highlight", "heading"]
})
export class RecommendationCardElement {
  card?: RecommendationCard;
  highlight = false;
  heading = "";

  get priceText(): string {
    return this.card ? `$${this.card.shelfPrice.toFixed(2)}` : "--";
  }

  get confidencePercent(): string {
    if (!this.card) {
      return "0%";
    }
    return `${Math.round(this.card.confidenceScore * 100)}%`;
  }
}
