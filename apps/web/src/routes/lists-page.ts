import { customElement } from "aurelia";
import template from "./lists-page.html?raw";
import { apiClient, type CompareMode, type FavoriteProductSummary, type SavedListSummary, type WatchlistSummary } from "../services/api-client";

@customElement({ name: "lists-page", template })
export class ListsPage {
  readonly api = apiClient();
  readonly modes: CompareMode[] = ["equivalent", "exact", "best-value"];

  isLoading = false;
  isSaving = false;
  error = "";
  lists: SavedListSummary[] = [];
  favorites: FavoriteProductSummary[] = [];
  watchlist: WatchlistSummary[] = [];

  formId?: string;
  name = "";
  description = "";
  mode: CompareMode = "equivalent";
  itemsText = "plain flour\nfull cream milk 2L\neggs";
  watchQuery = "";
  watchTargetPrice = "";
  watchNote = "";

  async attached(): Promise<void> {
    await this.refresh();
  }

  handleSaveSubmit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  handleWatchlistSubmit(event: Event): void {
    event.preventDefault();
    void this.saveWatchlist();
  }

  async refresh(): Promise<void> {
    this.isLoading = true;
    this.error = "";

    try {
      const [lists, favorites, watchlist] = await Promise.all([
        this.api.getSavedLists(),
        this.api.getFavorites(),
        this.api.getWatchlist()
      ]);
      this.lists = lists;
      this.favorites = favorites;
      this.watchlist = watchlist;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to load saved lists.";
    } finally {
      this.isLoading = false;
    }
  }

  editList(list: SavedListSummary): void {
    this.formId = list.id;
    this.name = list.name;
    this.description = list.description ?? "";
    this.mode = list.mode;
    this.itemsText = list.items.map((item) => item.query).join("\n");
  }

  resetForm(): void {
    this.formId = undefined;
    this.name = "";
    this.description = "";
    this.mode = "equivalent";
    this.itemsText = "";
  }

  async save(): Promise<void> {
    this.isSaving = true;
    this.error = "";

    try {
      await this.api.saveList({
        id: this.formId,
        name: this.name.trim(),
        description: this.description.trim() || undefined,
        mode: this.mode,
        items: this.itemsText
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((query, index) => ({ id: `${index + 1}`, query, quantity: 1 }))
      });
      await this.refresh();
      this.resetForm();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to save this list.";
    } finally {
      this.isSaving = false;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.api.deleteList(id);
      await this.refresh();
      if (this.formId === id) {
        this.resetForm();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to delete this list.";
    }
  }

  async saveWatchlist(): Promise<void> {
    try {
      const targetPrice = this.watchTargetPrice.trim() ? Number(this.watchTargetPrice.trim()) : undefined;
      await this.api.saveWatchlist({
        query: this.watchQuery.trim(),
        targetPrice: Number.isFinite(targetPrice) ? targetPrice : undefined,
        note: this.watchNote.trim() || undefined
      });
      this.watchQuery = "";
      this.watchTargetPrice = "";
      this.watchNote = "";
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to save this watchlist item.";
    }
  }

  async removeWatchlist(id: string): Promise<void> {
    try {
      await this.api.deleteWatchlist(id);
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to delete watchlist item.";
    }
  }

  async removeFavorite(productId: string): Promise<void> {
    try {
      await this.api.deleteFavorite(productId);
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to delete favorite product.";
    }
  }
}
