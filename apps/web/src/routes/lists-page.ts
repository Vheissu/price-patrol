import { IRouter } from "@aurelia/router";
import { customElement, resolve } from "aurelia";
import template from "./lists-page.html?raw";
import {
  apiClient,
  type BasketLineInput,
  type CompareMode,
  type FavoriteProductSummary,
  type SavedListSummary,
  type WatchlistSummary
} from "../services/api-client";
import { money, timeAgo } from "../format";

type ModeOption = {
  value: CompareMode;
  label: string;
};

type EditorItem = BasketLineInput & {
  quantity: number;
};

const DEFAULT_LIST_NAME = "Shopping list";

@customElement({ name: "lists-page", template })
export class ListsPage {
  readonly api = apiClient();
  private readonly router = resolve(IRouter);
  readonly modeOptions: ModeOption[] = [
    { value: "equivalent", label: "Flexible match" },
    { value: "exact", label: "Exact brand + pack" },
    { value: "best-value", label: "Best value" }
  ];

  isLoading = false;
  isSaving = false;
  error = "";
  statusMessage = "";
  lists: SavedListSummary[] = [];
  favorites: FavoriteProductSummary[] = [];
  watchlist: WatchlistSummary[] = [];

  formId?: string;
  name = DEFAULT_LIST_NAME;
  description = "";
  mode: CompareMode = "equivalent";
  draftItemQuery = "";
  draftItemQuantity = 1;
  editorItems: EditorItem[] = [
    { id: crypto.randomUUID(), query: "plain flour", quantity: 1 },
    { id: crypto.randomUUID(), query: "full cream milk 2L", quantity: 1 },
    { id: crypto.randomUUID(), query: "eggs", quantity: 1 }
  ];
  watchQuery = "";
  watchTargetPrice = "";
  watchNote = "";

  async attached(): Promise<void> {
    await this.refresh();
  }

  get orderedWatchlist(): WatchlistSummary[] {
    const rank = (entry: WatchlistSummary) =>
      entry.triggerState === "target-hit" ? 0 : entry.triggerState === "special" ? 1 : 2;
    return [...this.watchlist].sort((left, right) => rank(left) - rank(right));
  }

  get formHeading(): string {
    return this.formId ? `Editing ${this.name || "list"}` : "New list";
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

  modeText(mode: CompareMode): string {
    return this.modeOptions.find((option) => option.value === mode)?.label ?? mode;
  }

  editList(list: SavedListSummary): void {
    this.formId = list.id;
    this.name = list.name;
    this.description = list.description ?? "";
    this.mode = list.mode;
    this.editorItems = list.items.map((item) => ({
      id: crypto.randomUUID(),
      query: item.query,
      quantity: item.quantity ?? 1
    }));
    this.statusMessage = `Editing ${list.name}.`;
  }

  priceList(list: SavedListSummary): void {
    void this.router.load(`/basket?list=${encodeURIComponent(list.id)}`);
  }

  recheckFavorite(favorite: FavoriteProductSummary): void {
    void this.router.load(`/compare?q=${encodeURIComponent(favorite.canonicalName)}`);
  }

  recheckWatch(entry: WatchlistSummary): void {
    void this.router.load(`/compare?q=${encodeURIComponent(entry.query)}`);
  }

  resetForm(): void {
    this.formId = undefined;
    this.name = DEFAULT_LIST_NAME;
    this.description = "";
    this.mode = "equivalent";
    this.draftItemQuery = "";
    this.draftItemQuantity = 1;
    this.editorItems = [];
    this.statusMessage = "";
  }

  addEditorItem(): void {
    const query = this.draftItemQuery.trim();
    if (!query) {
      return;
    }

    const existing = this.editorItems.find((item) => normalizeListQuery(item.query) === normalizeListQuery(query));
    if (existing) {
      existing.quantity += Math.max(1, Number(this.draftItemQuantity) || 1);
      this.editorItems = [...this.editorItems];
    } else {
      this.editorItems = [
        ...this.editorItems,
        {
          id: crypto.randomUUID(),
          query,
          quantity: Math.max(1, Number(this.draftItemQuantity) || 1)
        }
      ];
    }

    this.draftItemQuery = "";
    this.draftItemQuantity = 1;
  }

  handleDraftKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    this.addEditorItem();
  }

  removeEditorItem(itemId: string): void {
    this.editorItems = this.editorItems.filter((item) => item.id !== itemId);
  }

  moveEditorItem(index: number, direction: -1 | 1): void {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.editorItems.length) {
      return;
    }

    const clone = [...this.editorItems];
    const [item] = clone.splice(index, 1);
    clone.splice(nextIndex, 0, item);
    this.editorItems = clone;
  }

  async save(): Promise<void> {
    this.isSaving = true;
    this.error = "";
    this.statusMessage = "";
    const isUpdating = Boolean(this.formId);

    try {
      if (!this.editorItems.length) {
        throw new Error("Add at least one item before saving this list.");
      }

      await this.api.saveList({
        id: this.formId,
        name: this.name.trim(),
        description: this.description.trim() || undefined,
        mode: this.mode,
        items: this.editorItems.map((item) => ({
          id: item.id,
          query: item.query.trim(),
          quantity: Math.max(1, Number(item.quantity) || 1)
        }))
      });
      await this.refresh();
      this.resetForm();
      this.statusMessage = isUpdating ? "List updated." : "List saved.";
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
    if (!this.watchQuery.trim()) {
      return;
    }
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
      this.error = error instanceof Error ? error.message : "Unable to delete favourite product.";
    }
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

  moneyOf(value: number): string {
    return money(value);
  }

  agoOf(value?: string): string {
    return timeAgo(value);
  }
}

function normalizeListQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
