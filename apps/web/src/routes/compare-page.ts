import { IRouteViewModel, Params, RouteNode } from "@aurelia/router";
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
import { getRecentSearches, recordRecentSearch } from "../services/recent-searches";
import { retailerLabel, retailerLogoUrl, timeAgo } from "../format";

type ProgressState = "done" | "active" | "pending";
type SortMode = "ranked" | "price";

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
const RECENT_LIMIT = 6;

@customElement({ name: "compare-page", template })
export class ComparePage implements IRouteViewModel {
  readonly modeOptions: ModeOption[] = [
    {
      value: "equivalent",
      label: "Flexible match",
      detail: "Close equivalents and store-brand substitutes can win when they line up well."
    },
    {
      value: "exact",
      label: "Exact brand + pack",
      detail: "Brand, variant and pack size stay tight. Use this when substitutes are not okay."
    },
    {
      value: "best-value",
      label: "Best value",
      detail: "Normalised value wins, so different pack sizes and equivalents can take it."
    }
  ];
  readonly progressPhases = [
    {
      title: "Preparing request",
      detail: "Applying your saved location and shaping the search query."
    },
    {
      title: "Checking retailer pages",
      detail: "Opening Woolworths, Coles and ALDI in their normal shopper flow."
    },
    {
      title: "Normalising products",
      detail: "Comparing pack sizes, unit prices, variants and substitutes."
    },
    {
      title: "Ranking results",
      detail: "Sorting direct matches, equivalents and fallback substitutes."
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
  allowLiveScrape = true;
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
  retailerFilter = "all";
  sortMode: SortMode = "ranked";
  progressStepIndex = 0;
  progressItems: ProgressItem[] = this.createProgressItems(0);
  savedLists: SavedListSummary[] = [];
  selectedListId = "";
  listMessage = "";
  recentSearches: string[] = [];
  private progressTimer: ReturnType<typeof window.setInterval> | undefined;
  private comparisonRequestId = 0;
  private explanationRequestId = 0;

  async loading(_params: Params, next: RouteNode): Promise<void> {
    this.recentSearches = getRecentSearches();
    const preload = next.queryParams.get("q");
    if (preload?.trim()) {
      this.query = preload.trim();
      await Promise.all([this.loadDefaultLocation(), this.refreshSavedLists()]);
      void this.runComparison();
      return;
    }
    await Promise.all([this.loadDefaultLocation(), this.refreshSavedLists()]);
  }

  detached(): void {
    this.stopProgress();
  }

  get comparedAtLabel(): string {
    if (!this.result?.comparedAt) {
      return "No refresh timestamp yet";
    }
    return `${timeAgo(this.result.comparedAt)} (${new Date(this.result.comparedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })})`;
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

  get allCandidates(): RecommendationCard[] {
    if (!this.result) {
      return [];
    }
    const recommended = this.result.recommended ? [this.result.recommended] : [];
    return [...recommended, ...this.result.alternatives];
  }

  get retailerFilters(): Array<{ id: string; label: string; logoUrl?: string }> {
    const retailers = new Set(this.allCandidates.map((card) => card.retailer));
    const filters: Array<{ id: string; label: string; logoUrl?: string }> = [
      { id: "all", label: "All stores" }
    ];
    for (const retailer of ["woolworths", "coles", "aldi"]) {
      if (retailers.has(retailer)) {
        filters.push({ id: retailer, label: retailerLabel(retailer), logoUrl: retailerLogoUrl(retailer) });
      }
    }
    for (const retailer of retailers) {
      if (!["woolworths", "coles", "aldi"].includes(retailer)) {
        filters.push({ id: retailer, label: retailerLabel(retailer) });
      }
    }
    return filters;
  }

  get visibleAlternatives(): RecommendationCard[] {
    let cards = this.allCandidates;
    if (this.retailerFilter !== "all") {
      cards = cards.filter((card) => card.retailer === this.retailerFilter);
    }
    if (this.sortMode === "price") {
      cards = [...cards].sort((left, right) => displayPrice(left) - displayPrice(right));
    }
    return cards;
  }

  get selectedModeDetail(): string {
    return this.modeOptions.find((option) => option.value === this.mode)?.detail ?? "";
  }

  get selectedIsRecommended(): boolean {
    return Boolean(this.selectedCard && this.result?.recommended && this.selectedCard === this.result.recommended);
  }

  get heroFlag(): string {
    if (this.selectedIsRecommended) {
      return "Best price";
    }
    return this.selectedCard?.confidenceLabel ?? "";
  }

  get historyWindow(): string {
    if (this.history.length < 2) {
      return "";
    }
    const first = new Date(this.history[this.history.length - 1].observedAt);
    const last = new Date(this.history[0].observedAt);
    const fmt = (date: Date) => date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
    return `${fmt(first)} to ${fmt(last)}`;
  }

  applySearch(query: string): void {
    this.query = query;
    void this.runComparison();
  }

  async runComparison(): Promise<void> {
    const trimmedQuery = this.query.trim();
    if (!trimmedQuery || this.isSubmitting) {
      return;
    }

    const requestId = ++this.comparisonRequestId;
    this.isSubmitting = true;
    this.startProgress();
    this.error = "";
    this.result = undefined;
    this.selectedCard = undefined;
    this.history = [];
    this.explanation = undefined;
    this.explanationError = "";
    this.retailerFilter = "all";
    this.sortMode = "ranked";
    this.favoriteMessage = "";
    this.watchlistMessage = "";
    this.correctionMessage = "";
    this.listMessage = "";

    try {
      const response = await this.api.compareItem({
        query: trimmedQuery,
        mode: this.mode,
        postcode: this.postcode.trim() || undefined,
        suburb: this.suburb.trim() || undefined,
        allowLiveScrape: this.allowLiveScrape
      });
      if (requestId !== this.comparisonRequestId) {
        return;
      }
      this.result = response;
      this.selectedCard = this.result.recommended ?? this.result.alternatives[0];
      recordRecentSearch(trimmedQuery);
      this.recentSearches = getRecentSearches().slice(0, RECENT_LIMIT);
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

  setRetailerFilter(id: string): void {
    this.retailerFilter = id;
  }

  async saveFavorite(): Promise<void> {
    if (!this.selectedCard) {
      return;
    }

    this.isSavingFavorite = true;
    this.favoriteMessage = "";
    try {
      await this.api.saveFavorite(this.selectedCard);
      this.favoriteMessage = `Saved ${this.selectedCard.productName} to favourites.`;
    } catch (error) {
      this.favoriteMessage = error instanceof Error ? error.message : "Unable to save favourite.";
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
        retailer: this.selectedCard?.retailer as "coles" | "woolworths" | "aldi" | undefined,
        targetPrice: Number.isFinite(targetPrice) ? targetPrice : undefined
      });
      this.watchlistMessage = "Added to the watchlist.";
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
        retailer: this.selectedCard.retailer as "coles" | "woolworths" | "aldi",
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

  retailerLogo(card: RecommendationCard): string {
    return retailerLogoUrl(card.retailer);
  }

  cardPrice(card: RecommendationCard): string {
    return `$${displayPrice(card).toFixed(2)}`;
  }

  cardHasPromo(card: RecommendationCard): boolean {
    return card.promotionalPrice != null && card.promotionalPrice < card.shelfPrice;
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

    const stale = () =>
      requestId !== this.explanationRequestId ||
      !this.result ||
      !this.selectedCard ||
      this.selectedCard.productId !== selectedProductId ||
      this.result.query !== comparisonQuery;

    try {
      const [history, apiExplanation] = await Promise.allSettled([
        this.api.getProductHistory(selectedProductId, 90),
        this.api.explainItem({
          query: comparisonQuery,
          productId: selectedProductId,
          mode: this.mode,
          allowLiveScrape: this.allowLiveScrape
        })
      ]);
      if (stale()) {
        return;
      }
      if (history.status === "fulfilled") {
        this.history = history.value;
      }
      if (apiExplanation.status === "fulfilled") {
        this.explanation = apiExplanation.value;
      } else {
        this.explanationError = apiExplanation.reason instanceof Error ? apiExplanation.reason.message : "Explanation unavailable.";
      }
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

  progressMarkerSymbol(item: ProgressItem): string {
    switch (item.state) {
      case "done":
        return "✓";
      case "active":
        return "·";
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

function displayPrice(card: RecommendationCard): number {
  return card.promotionalPrice != null && card.promotionalPrice < card.shelfPrice
    ? card.promotionalPrice
    : card.shelfPrice;
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
