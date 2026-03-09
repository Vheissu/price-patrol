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

  get retailerLogoUrl(): string {
    return this.card ? `/retailers/${this.card.retailer}.svg` : "";
  }

  get retailerLabel(): string {
    if (!this.card) {
      return "";
    }

    return this.card.retailer === "aldi" ? "ALDI" : this.card.retailer.charAt(0).toUpperCase() + this.card.retailer.slice(1);
  }
}
