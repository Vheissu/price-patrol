import { customElement } from "aurelia";
import template from "./compare-page.html?raw";
import {
  apiClient,
  type CompareMode,
  type ItemExplanation,
  type ProductHistoryPoint,
  type RecommendationCard,
  type SavedListSummary,
  type SingleCompareResponse
} from "../services/api-client";

type ProgressState = "done" | "active" | "pending";

type ProgressItem = {
  title: string;
  detail: string;
  state: ProgressState;
};

type ModeOption = {
  value: CompareMode;
  label: string;
  detail: string;
};

const DEFAULT_LIST_NAME = "Shopping list";

@customElement({ name: "compare-page", template })
export class ComparePage {
  readonly modeOptions: ModeOption[] = [
    {
      value: "equivalent",
      label: "Flexible match",
      detail: "Allows close equivalents and store-brand substitutes when they line up well."
    },
    {
      value: "exact",
      label: "Exact brand + pack",
      detail: "Keeps brand, variant, and pack size tight. Use this when substitutes are not okay."
    },
    {
      value: "best-value",
      label: "Best value",
      detail: "Optimizes for normalized value, so different pack sizes and equivalents can win."
    }
  ];
  readonly progressPhases = [
    {
      title: "Preparing request",
      detail: "Applying your saved location and shaping the search query."
    },
    {
      title: "Checking retailer pages",
      detail: "Opening Woolworths, Coles, and ALDI in their normal shopper flow."
    },
    {
      title: "Normalizing products",
      detail: "Comparing pack sizes, unit prices, variants, and substitutes."
    },
    {
      title: "Ranking results",
      detail: "Sorting direct matches, equivalents, and fallback substitutes."
    }
  ] as const;
  readonly retailerSequence = [
    { retailer: "woolworths", label: "Woolworths", logoUrl: "/retailers/woolworths.svg" },
    { retailer: "coles", label: "Coles", logoUrl: "/retailers/coles.svg" },
    { retailer: "aldi", label: "ALDI", logoUrl: "/retailers/aldi.svg" }
  ] as const;
  readonly api = apiClient();

  query = "";
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
  isSavingList = false;
  showPriceIntel = true;
  showExplanation = false;
  showNotes = false;
  progressStepIndex = 0;
  progressItems: ProgressItem[] = this.createProgressItems(0);
  savedLists: SavedListSummary[] = [];
  selectedListId = "";
  listMessage = "";
  private progressTimer: ReturnType<typeof window.setInterval> | undefined;
  private comparisonRequestId = 0;
  private explanationRequestId = 0;

  async attached(): Promise<void> {
    await Promise.all([this.loadDefaultLocation(), this.refreshSavedLists()]);
  }

  detached(): void {
    this.stopProgress();
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

  get selectedModeDetail(): string {
    return this.modeOptions.find((option) => option.value === this.mode)?.detail ?? "";
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

  private async refreshSavedLists(): Promise<void> {
    try {
      this.savedLists = await this.api.getSavedLists();
      if (!this.savedLists.length) {
        this.selectedListId = "";
        return;
      }

      const selectedListStillExists = this.savedLists.some((list) => list.id === this.selectedListId);
      if (!selectedListStillExists) {
        this.selectedListId = this.savedLists.length === 1 ? this.savedLists[0].id : "";
      }
    } catch {
      this.savedLists = [];
      this.selectedListId = "";
    }
  }

  async runComparison(): Promise<void> {
    const requestId = ++this.comparisonRequestId;
    this.isSubmitting = true;
    this.startProgress();
    this.error = "";
    this.result = undefined;
    this.selectedCard = undefined;
    this.history = [];
    this.explanation = undefined;
    this.explanationError = "";

    try {
      const response = await this.api.compareItem({
        query: this.query.trim(),
        mode: this.mode,
        postcode: this.postcode.trim() || undefined,
        suburb: this.suburb.trim() || undefined
      });
      if (requestId !== this.comparisonRequestId) {
        return;
      }
      this.result = response;
      this.selectedCard = this.result.recommended ?? this.result.alternatives[0];
      void this.loadExplanation();
    } catch (error) {
      if (requestId !== this.comparisonRequestId) {
        return;
      }
      this.error = error instanceof Error ? error.message : "Unable to compare this item right now.";
      this.result = undefined;
      this.explanation = undefined;
    } finally {
      if (requestId === this.comparisonRequestId) {
        this.isSubmitting = false;
        this.stopProgress();
      }
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

  async addToList(): Promise<void> {
    const query = this.query.trim();
    if (!query) {
      return;
    }

    this.isSavingList = true;
    this.listMessage = "";

    try {
      const existingList =
        this.savedLists.find((list) => list.id === this.selectedListId) ??
        this.savedLists.find((list) => normalizeListQuery(list.name) === normalizeListQuery(DEFAULT_LIST_NAME));
      const savedList = await this.api.saveList({
        id: existingList?.id,
        name: existingList?.name ?? DEFAULT_LIST_NAME,
        description: existingList?.description,
        mode: existingList?.mode ?? this.mode,
        items: mergeListItems(existingList?.items ?? [], query)
      });
      await this.refreshSavedLists();
      this.selectedListId = savedList.id;
      this.listMessage = `Added to ${savedList.name}.`;
    } catch (error) {
      this.listMessage = error instanceof Error ? error.message : "Unable to add this item to a list.";
    } finally {
      this.isSavingList = false;
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

    const requestId = ++this.explanationRequestId;
    const selectedProductId = this.selectedCard.productId;
    const comparisonQuery = this.result.query;
    this.isExplanationLoading = true;
    this.explanationError = "";
    this.explanation = this.buildLocalExplanation(this.selectedCard, this.result.query);

    try {
      const history = await this.api.getProductHistory(this.selectedCard.productId);
      if (!this.result || !this.selectedCard) {
        return;
      }
      if (requestId !== this.explanationRequestId) {
        return;
      }
      if (this.selectedCard.productId !== selectedProductId || this.result.query !== comparisonQuery) {
        return;
      }
      this.history = history;
    } catch (error) {
      if (requestId !== this.explanationRequestId) {
        return;
      }
      this.explanationError = error instanceof Error ? error.message : "Price history unavailable.";
      this.history = [];
    } finally {
      if (requestId === this.explanationRequestId) {
        this.isExplanationLoading = false;
      }
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

  private startProgress(): void {
    this.stopProgress();
    this.progressStepIndex = 0;
    this.progressItems = this.createProgressItems(0);
    this.progressTimer = window.setInterval(() => {
      const nextIndex = Math.min(this.progressStepIndex + 1, this.progressPhases.length - 1);
      this.progressStepIndex = nextIndex;
      this.progressItems = this.createProgressItems(nextIndex);
    }, 1_250);
  }

  private stopProgress(): void {
    if (this.progressTimer != null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
  }

  progressItemClass(item: ProgressItem): string {
    return `progress-step progress-step--${item.state}`;
  }

  progressMarkerLabel(item: ProgressItem): string {
    switch (item.state) {
      case "done":
        return "Done";
      case "active":
        return "In progress";
      default:
        return "Pending";
    }
  }

  progressMarkerSymbol(item: ProgressItem): string {
    switch (item.state) {
      case "done":
        return "✓";
      case "active":
        return "...";
      default:
        return "";
    }
  }

  private createProgressItems(activeIndex: number): ProgressItem[] {
    return this.progressPhases.map((phase, index) => ({
      ...phase,
      state: activeIndex > index ? "done" : activeIndex === index ? "active" : "pending"
    }));
  }
}

function mergeListItems(existingItems: SavedListSummary["items"], query: string): SavedListSummary["items"] {
  const normalizedQuery = normalizeListQuery(query);
  const items = existingItems.map((item) => ({ ...item }));
  const existingItem = items.find((item) => normalizeListQuery(item.query) === normalizedQuery);
  if (existingItem) {
    existingItem.quantity = (existingItem.quantity ?? 1) + 1;
    return items;
  }

  return [
    ...items,
    {
      id: crypto.randomUUID(),
      query,
      quantity: 1
    }
  ];
}

function normalizeListQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
