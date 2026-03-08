import { customElement } from "aurelia";
import template from "./compare-page.html?raw";
import {
  apiClient,
  type CompareMode,
  type ItemExplanation,
  type ProductHistoryPoint,
  type RecommendationCard,
  type SingleCompareResponse
} from "../services/api-client";

@customElement({ name: "compare-page", template })
export class ComparePage {
  readonly modes: CompareMode[] = ["equivalent", "exact", "best-value"];
  readonly api = apiClient();

  query = "plain flour";
  postcode = "";
  suburb = "";
  mode: CompareMode = "equivalent";
  isSubmitting = false;
  error = "";
  result?: SingleCompareResponse;
  explanation?: ItemExplanation;
  explanationError = "";
  isExplanationLoading = false;
  selectedCard?: RecommendationCard;
  favoriteMessage = "";
  watchlistMessage = "";
  correctionMessage = "";
  targetPriceText = "";
  history: ProductHistoryPoint[] = [];
  isSavingFavorite = false;
  isSavingWatchlist = false;
  isSavingCorrection = false;
  showPriceIntel = true;
  showExplanation = false;
  showNotes = false;

  async attached(): Promise<void> {
    await this.loadDefaultLocation();
    await this.runComparison();
  }

  get comparedAtLabel(): string {
    if (!this.result?.comparedAt) {
      return "No refresh timestamp yet";
    }
    return new Date(this.result.comparedAt).toLocaleString();
  }

  get recommendedFreshnessState(): "fresh" | "recent" | "aging" | "stale" {
    switch (this.result?.recommended?.freshnessLabel) {
      case "Fresh":
        return "fresh";
      case "Recent":
        return "recent";
      case "Aging":
        return "aging";
      default:
        return "stale";
    }
  }

  get recentHistory(): ProductHistoryPoint[] {
    return this.history.slice(0, 5);
  }

  handleSubmit(event: Event): void {
    event.preventDefault();
    void this.runComparison();
  }

  private async loadDefaultLocation(): Promise<void> {
    if (this.postcode || this.suburb) {
      return;
    }

    try {
      const health = await this.api.getHealth();
      this.postcode = health.defaultLocation?.postcode ?? "";
      this.suburb = health.defaultLocation?.suburb ?? "";
    } catch {
      // Leave the form empty and allow the backend to apply defaults.
    }
  }

  async runComparison(): Promise<void> {
    this.isSubmitting = true;
    this.error = "";

    try {
      this.result = await this.api.compareItem({
        query: this.query.trim(),
        mode: this.mode,
        postcode: this.postcode.trim() || undefined,
        suburb: this.suburb.trim() || undefined
      });
      this.selectedCard = this.result.recommended ?? this.result.alternatives[0];
      await this.loadExplanation();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to compare this item right now.";
      this.result = undefined;
      this.explanation = undefined;
    } finally {
      this.isSubmitting = false;
    }
  }

  async selectCard(card: RecommendationCard): Promise<void> {
    this.selectedCard = card;
    await this.loadExplanation();
  }

  async saveFavorite(): Promise<void> {
    if (!this.selectedCard) {
      return;
    }

    this.isSavingFavorite = true;
    this.favoriteMessage = "";
    try {
      await this.api.saveFavorite(this.selectedCard);
      this.favoriteMessage = "Saved to favorites.";
    } catch (error) {
      this.favoriteMessage = error instanceof Error ? error.message : "Unable to save favorite.";
    } finally {
      this.isSavingFavorite = false;
    }
  }

  async saveWatchlist(): Promise<void> {
    if (!this.result?.query) {
      return;
    }

    this.isSavingWatchlist = true;
    this.watchlistMessage = "";
    const targetPrice = this.targetPriceText.trim() ? Number(this.targetPriceText.trim()) : undefined;

    try {
      await this.api.saveWatchlist({
        query: this.result.query,
        productId: this.selectedCard?.productId,
        retailer: this.selectedCard?.retailer,
        targetPrice: Number.isFinite(targetPrice) ? targetPrice : undefined
      });
      this.watchlistMessage = "Added to watchlist.";
    } catch (error) {
      this.watchlistMessage = error instanceof Error ? error.message : "Unable to save watchlist item.";
    } finally {
      this.isSavingWatchlist = false;
    }
  }

  async saveMatchPreference(): Promise<void> {
    if (!this.result?.query || !this.selectedCard) {
      return;
    }

    this.isSavingCorrection = true;
    this.correctionMessage = "";
    try {
      await this.api.saveMatchPreference({
        query: this.result.query,
        productId: this.selectedCard.productId,
        retailer: this.selectedCard.retailer,
        productName: this.selectedCard.productName
      });
      this.correctionMessage = "Saved as your preferred substitute for this query.";
      await this.runComparison();
    } catch (error) {
      this.correctionMessage = error instanceof Error ? error.message : "Unable to save preferred substitute.";
    } finally {
      this.isSavingCorrection = false;
    }
  }

  private async loadExplanation(): Promise<void> {
    if (!this.result || !this.selectedCard) {
      this.explanation = undefined;
      this.history = [];
      return;
    }

    this.isExplanationLoading = true;
    this.explanationError = "";
    this.explanation = this.buildLocalExplanation(this.selectedCard, this.result.query);

    try {
      this.history = await this.api.getProductHistory(this.selectedCard.productId);
    } catch (error) {
      this.explanationError = error instanceof Error ? error.message : "Price history unavailable.";
      this.history = [];
    } finally {
      this.isExplanationLoading = false;
    }
  }

  private buildLocalExplanation(card: RecommendationCard, query: string): ItemExplanation {
    const rankingFactors = [
      card.unitPrice ? `Unit price: ${card.unitPrice}.` : `Shelf price: $${card.shelfPrice.toFixed(2)}.`,
      `Freshness: ${card.freshnessLabel}.`,
      `Availability: ${card.availability}.`
    ];

    if (card.savingsVsNext != null) {
      rankingFactors.push(`Savings versus next comparable option: $${card.savingsVsNext.toFixed(2)}.`);
    }

    return {
      summary: `${card.productName} ranked as a ${card.confidenceLabel.toLowerCase()} match for "${query}".`,
      reasons: card.rankingReasons,
      rankingFactors,
      exclusions: []
    };
  }
}
