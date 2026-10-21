import { IRouteViewModel, IRouter, Params, RouteNode } from "@aurelia/router";
import { customElement, resolve } from "aurelia";
import template from "./today-page.html?raw";
import {
  apiClient,
  type AdapterHealthSummary,
  type DealSummary,
  type FavoriteProductSummary,
  type ProductHistoryPoint,
  type WatchlistSummary
} from "../services/api-client";
import { getRecentSearches } from "../services/recent-searches";
import { money, timeAgo } from "../format";

interface FavoriteTrend {
  productId: string;
  direction: "down" | "up" | "flat";
  deltaText: string;
  history: ProductHistoryPoint[];
}

@customElement({ name: "today-page", template })
export class TodayPage implements IRouteViewModel {
  readonly api = apiClient();
  private readonly router = resolve(IRouter);

  isLoading = true;
  error = "";
  quickQuery = "";

  adapters: AdapterHealthSummary[] = [];
  watchlist: WatchlistSummary[] = [];
  favorites: FavoriteProductSummary[] = [];
  deals: DealSummary[] = [];
  favoriteTrends = new Map<string, FavoriteTrend>();
  recentSearches: string[] = [];

  async loading(_params: Params, _next: RouteNode): Promise<void> {
    this.recentSearches = getRecentSearches();
    await this.refresh();
  }

  get dateLine(): string {
    return new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
  }

  get triggeredWatches(): WatchlistSummary[] {
    return this.watchlist.filter((entry) => entry.triggerState !== "watching");
  }

  get orderedWatchlist(): WatchlistSummary[] {
    const rank = (entry: WatchlistSummary) =>
      entry.triggerState === "target-hit" ? 0 : entry.triggerState === "special" ? 1 : 2;
    return [...this.watchlist].sort((left, right) => rank(left) - rank(right));
  }

  get dealRows(): DealSummary[] {
    return this.deals.slice(0, 12);
  }

  get favoriteRows(): FavoriteProductSummary[] {
    return this.favorites.slice(0, 6);
  }

  get anyHealthy(): boolean {
    return this.adapters.some((adapter) => adapter.status === "healthy");
  }

  async refresh(): Promise<void> {
    this.isLoading = true;
    this.error = "";

    const [adapters, watchlist, favorites, deals] = await Promise.allSettled([
      this.api.getAdapterHealth(),
      this.api.getWatchlist(),
      this.api.getFavorites(),
      this.api.getDeals({ days: 21, limit: 24 })
    ]);

    this.adapters = adapters.status === "fulfilled" ? adapters.value : [];
    this.watchlist = watchlist.status === "fulfilled" ? watchlist.value : [];
    this.favorites = favorites.status === "fulfilled" ? favorites.value : [];
    this.deals = deals.status === "fulfilled" ? deals.value : [];

    if (adapters.status === "rejected" && watchlist.status === "rejected" && favorites.status === "rejected") {
      this.error = "The price file is unreachable. Is the API running?";
    }

    this.isLoading = false;
    void this.loadFavoriteTrends();
  }

  submitQuickCompare(): void {
    const query = this.quickQuery.trim();
    if (!query) {
      return;
    }
    void this.router.load(`/compare?q=${encodeURIComponent(query)}`);
  }

  compareQuery(query: string): void {
    void this.router.load(`/compare?q=${encodeURIComponent(query)}`);
  }

  dealQuery(deal: DealSummary): string {
    return deal.queryText || deal.productName;
  }

  watchStateLabel(entry: WatchlistSummary): string {
    switch (entry.triggerState) {
      case "target-hit":
        return "Target hit";
      case "special":
        return "On special";
      default:
        return "Watching";
    }
  }

  watchStateClass(entry: WatchlistSummary): string {
    return `watch-state watch-state--${entry.triggerState}`;
  }

  adapterStatusLabel(adapter: AdapterHealthSummary): string {
    return adapter.status.charAt(0).toUpperCase() + adapter.status.slice(1);
  }

  adapterModeLabel(adapter: AdapterHealthSummary): string {
    switch (adapter.browserMode) {
      case "live":
        return "live checks";
      case "historical":
        return "saved data";
      default:
        return "live + saved";
    }
  }

  trendFor(productId: string): FavoriteTrend | undefined {
    return this.favoriteTrends.get(productId);
  }

  moneyOf(value: number): string {
    return money(value);
  }

  agoOf(value?: string): string {
    return timeAgo(value);
  }

  private async loadFavoriteTrends(): Promise<void> {
    const targets = this.favoriteRows;
    const results = await Promise.allSettled(
      targets.map((favorite) => this.api.getProductHistory(favorite.productId, 45))
    );

    const trends = new Map<string, FavoriteTrend>();
    results.forEach((result, index) => {
      if (result.status !== "fulfilled" || result.value.length < 2) {
        return;
      }
      const history = result.value;
      const latest = history[0].effectivePrice;
      const previous = history[1].effectivePrice;
      const delta = latest - previous;
      const direction: FavoriteTrend["direction"] = Math.abs(delta) < 0.005 ? "flat" : delta < 0 ? "down" : "up";
      trends.set(targets[index].productId, {
        productId: targets[index].productId,
        direction,
        deltaText: direction === "flat" ? "steady" : `${delta < 0 ? "-" : "+"}$${Math.abs(delta).toFixed(2)}`,
        history
      });
    });
    this.favoriteTrends = trends;
  }
}
