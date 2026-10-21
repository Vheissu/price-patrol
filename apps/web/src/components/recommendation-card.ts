import { customElement } from "aurelia";
import template from "./recommendation-card.html?raw";
import type { RecommendationCard } from "../services/api-client";
import { retailerLogoUrl } from "../format";

@customElement({
  name: "recommendation-card",
  template,
  bindables: ["card", "flag"]
})
export class RecommendationCardElement {
  card?: RecommendationCard;
  flag = "";

  get displayPrice(): string {
    if (!this.card) {
      return "--";
    }
    const price = this.card.promotionalPrice != null && this.card.promotionalPrice < this.card.shelfPrice
      ? this.card.promotionalPrice
      : this.card.shelfPrice;
    return `$${price.toFixed(2)}`;
  }

  get shelfPriceText(): string {
    return this.card ? `$${this.card.shelfPrice.toFixed(2)}` : "";
  }

  get hasPromoPrice(): boolean {
    return Boolean(
      this.card?.promotionalPrice != null && this.card.promotionalPrice < this.card.shelfPrice
    );
  }

  get confidencePercent(): string {
    if (!this.card) {
      return "0%";
    }
    return `${Math.round(this.card.confidenceScore * 100)}%`;
  }

  get availabilityLabel(): string {
    if (!this.card) {
      return "";
    }
    return this.card.availability
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  get sourceLabel(): string {
    switch (this.card?.sourceType) {
      case "historical":
        return "saved catalogue";
      case "detail":
        return "product page";
      case "network":
        return "store feed";
      default:
        return "search listing";
    }
  }

  get seenLabel(): string {
    const seen = this.card?.priceIntelligence?.seenCount;
    if (!seen) {
      return "New";
    }
    return `${seen} sighting${seen === 1 ? "" : "s"}`;
  }

  get retailerLogoUrl(): string {
    return this.card ? retailerLogoUrl(this.card.retailer) : "";
  }

  get hasLogo(): boolean {
    return ["coles", "woolworths", "aldi"].includes(this.card?.retailer ?? "");
  }
}
