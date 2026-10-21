import { IRouteViewModel, Params, RouteNode } from "@aurelia/router";
import { customElement } from "aurelia";
import template from "./basket-page.html?raw";
import {
  apiClient,
  type BasketCompareResponse,
  type BasketLineInput,
  type BasketPlan,
  type CompareMode,
  type RecommendationCard,
  type SavedListSummary
} from "../services/api-client";
import { retailerLabel } from "../format";

interface BasketRow extends BasketLineInput {
  quantity: number;
}

interface StoreRun {
  retailer: string;
  label: string;
  items: Array<{ item: string; quantity: number; cost: number; productName?: string }>;
  subtotal: number;
}

type ModeOption = {
  value: CompareMode;
  label: string;
  detail: string;
};

const DEFAULT_LIST_NAME = "Shopping list";

@customElement({ name: "basket-page", template })
export class BasketPage implements IRouteViewModel {
  readonly api = apiClient();
  readonly modeOptions: ModeOption[] = [
    {
      value: "equivalent",
      label: "Flexible match",
      detail: "Close equivalents and substitutes can fill a line."
    },
    {
      value: "exact",
      label: "Exact brand + pack",
      detail: "Lines stay close to the exact products you wrote down."
    },
    {
      value: "best-value",
      label: "Best value",
      detail: "Normalised value wins, even when pack sizes differ."
    }
  ];

  mode: CompareMode = "equivalent";
  postcode = "";
  suburb = "";
  allowLiveScrape = true;
  isSubmitting = false;
  elapsedSeconds = 0;
  isSavingList = false;
  error = "";
  listMessage = "";
  basket?: BasketCompareResponse;
  draftItem = "";
  selectedListId = "";
  listName = DEFAULT_LIST_NAME;
  listDescription = "";
  savedLists: SavedListSummary[] = [];
  expandedLines = new Set<string>();
  rows: BasketRow[] = [
    { id: crypto.randomUUID(), query: "plain flour", quantity: 1 },
    { id: crypto.randomUUID(), query: "full cream milk 2L", quantity: 1 },
    { id: crypto.randomUUID(), query: "eggs", quantity: 1 }
  ];
  private elapsedTimer: ReturnType<typeof window.setInterval> | undefined;

  async loading(_params: Params, next: RouteNode): Promise<void> {
    await Promise.all([this.loadDefaultLocation(), this.refreshSavedLists()]);
    const listId = next.queryParams.get("list");
    if (listId && this.savedLists.some((list) => list.id === listId)) {
      this.selectedListId = listId;
      this.loadSelectedList();
    }
  }

  detached(): void {
    this.stopElapsed();
  }

  get comparedAtLabel(): string {
    if (!this.basket?.comparedAt) {
      return "";
    }
    return new Date(this.basket.comparedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  }

  get selectedModeDetail(): string {
    return this.modeOptions.find((option) => option.value === this.mode)?.detail ?? "";
  }

  get strategies(): BasketPlan[] {
    if (!this.basket) {
      return [];
    }
    return [...this.basket.strategies].sort((left, right) => {
      if (left.name === "Split basket") {
        return -1;
      }
      if (right.name === "Split basket") {
        return 1;
      }
      return left.total - right.total;
    });
  }

  get splitPlan(): BasketPlan | undefined {
    return this.basket?.strategies.find((strategy) => strategy.name === "Split basket");
  }

  get bestSingleStore(): BasketPlan | undefined {
    return this.basket?.strategies
      .filter((strategy) => strategy.name !== "Split basket" && !(strategy.missingItems?.length))
      .sort((left, right) => left.total - right.total)[0];
  }

  get splitSavingsLabel(): string {
    const split = this.splitPlan;
    const single = this.bestSingleStore;
    if (!split || !single) {
      return "";
    }
    const delta = single.total - split.total;
    if (delta <= 0.005) {
      return "Splitting saves nothing, one store does it all.";
    }
    return `Splitting saves $${delta.toFixed(2)} versus ${single.name}.`;
  }

  get storeRuns(): StoreRun[] {
    const split = this.splitPlan;
    if (!split?.allocations?.length) {
      return [];
    }

    const groups = new Map<string, StoreRun>();
    for (const allocation of split.allocations) {
      const retailer = allocation.retailer;
      let group = groups.get(retailer);
      if (!group) {
        group = { retailer, label: retailerLabel(retailer), items: [], subtotal: 0 };
        groups.set(retailer, group);
      }
      group.items.push({
        item: allocation.item,
        quantity: allocation.quantity,
        cost: allocation.cost,
        productName: allocation.productName
      });
      group.subtotal += allocation.cost * allocation.quantity;
    }

    return Array.from(groups.values())
      .filter((group) => group.retailer !== "unmatched")
      .sort((left, right) => right.subtotal - left.subtotal);
  }

  get unmatchedItemsLabel(): string {
    return this.unmatchedLines.map((line) => line.item).join(", ");
  }

  get unmatchedLines(): Array<{ item: string; quantity: number }> {
    return (this.splitPlan?.allocations ?? [])
      .filter((allocation) => allocation.retailer === "unmatched")
      .map((allocation) => ({ item: allocation.item, quantity: allocation.quantity }));
  }

  handleDraftKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    void this.addRow();
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
        this.listName = DEFAULT_LIST_NAME;
        this.listDescription = "";
        return;
      }

      const selectedListStillExists = this.savedLists.some((list) => list.id === this.selectedListId);
      if (!selectedListStillExists) {
        this.selectedListId = this.savedLists.length === 1 ? this.savedLists[0].id : "";
      }

      if (this.selectedListId) {
        this.syncSelectedListFields();
      }
    } catch {
      this.savedLists = [];
      this.selectedListId = "";
    }
  }

  async addRow(): Promise<void> {
    const query = this.draftItem.trim();
    if (!query) {
      return;
    }
    this.rows = [...this.rows, { id: crypto.randomUUID(), query, quantity: 1 }];
    this.draftItem = "";
  }

  handleSelectedListChange(): void {
    if (!this.selectedListId) {
      this.listName = DEFAULT_LIST_NAME;
      this.listDescription = "";
      return;
    }

    this.syncSelectedListFields();
  }

  removeRow(rowId: string): void {
    this.rows = this.rows.filter((row) => row.id !== rowId);
  }

  moveRow(index: number, direction: -1 | 1): void {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.rows.length) {
      return;
    }
    const clone = [...this.rows];
    const [row] = clone.splice(index, 1);
    clone.splice(nextIndex, 0, row);
    this.rows = clone;
  }

  toggleLine(lineId: string): void {
    const next = new Set(this.expandedLines);
    if (next.has(lineId)) {
      next.delete(lineId);
    } else {
      next.add(lineId);
    }
    this.expandedLines = next;
  }

  isLineExpanded(lineId: string): boolean {
    return this.expandedLines.has(lineId);
  }

  lineOptions(line: BasketCompareResponse["lines"][number]): RecommendationCard[] {
    return [line.recommended, ...line.alternatives].filter((card): card is RecommendationCard => Boolean(card));
  }

  lineCost(card: RecommendationCard, quantity: number): string {
    const unit = card.promotionalPrice != null && card.promotionalPrice < card.shelfPrice
      ? card.promotionalPrice
      : card.shelfPrice;
    return `$${(unit * quantity).toFixed(2)}`;
  }

  loadSelectedList(): void {
    const list = this.savedLists.find((entry) => entry.id === this.selectedListId);
    if (!list) {
      return;
    }

    this.rows = list.items.map((item) => ({
      id: crypto.randomUUID(),
      query: item.query,
      quantity: item.quantity ?? 1
    }));
    this.mode = list.mode;
    this.listName = list.name;
    this.listDescription = list.description ?? "";
    this.listMessage = `Loaded ${list.name}.`;
  }

  async saveCurrentList(): Promise<void> {
    if (!this.rows.length) {
      this.listMessage = "Add at least one item before saving a list.";
      return;
    }

    this.isSavingList = true;
    this.listMessage = "";

    try {
      const selectedList =
        this.savedLists.find((entry) => entry.id === this.selectedListId) ??
        this.savedLists.find((entry) => normalizeListName(entry.name) === normalizeListName(DEFAULT_LIST_NAME));
      const savedList = await this.api.saveList({
        id: selectedList?.id,
        name: this.listName.trim() || selectedList?.name || DEFAULT_LIST_NAME,
        description: this.listDescription.trim() || undefined,
        mode: this.mode,
        items: this.rows.map((row) => ({
          id: row.id,
          query: row.query.trim(),
          quantity: row.quantity
        }))
      });
      await this.refreshSavedLists();
      this.selectedListId = savedList.id;
      this.listName = savedList.name;
      this.listDescription = savedList.description ?? "";
      this.listMessage = `${selectedList ? "Updated" : "Saved"} ${savedList.name}.`;
    } catch (error) {
      this.listMessage = error instanceof Error ? error.message : "Unable to save this list.";
    } finally {
      this.isSavingList = false;
    }
  }

  async compareBasket(): Promise<void> {
    if (this.isSubmitting || !this.rows.length) {
      return;
    }

    this.isSubmitting = true;
    this.error = "";
    this.expandedLines = new Set();
    this.startElapsed();

    try {
      this.basket = await this.api.compareBasket({
        mode: this.mode,
        postcode: this.postcode.trim() || undefined,
        suburb: this.suburb.trim() || undefined,
        allowLiveScrape: this.allowLiveScrape,
        items: this.rows.map((row) => ({ id: row.id, query: row.query, quantity: row.quantity }))
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to price this basket right now.";
      this.basket = undefined;
    } finally {
      this.isSubmitting = false;
      this.stopElapsed();
    }
  }

  private startElapsed(): void {
    this.stopElapsed();
    this.elapsedSeconds = 0;
    this.elapsedTimer = window.setInterval(() => {
      this.elapsedSeconds += 1;
    }, 1_000);
  }

  private stopElapsed(): void {
    if (this.elapsedTimer != null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  private syncSelectedListFields(): void {
    const list = this.savedLists.find((entry) => entry.id === this.selectedListId);
    if (!list) {
      return;
    }

    this.listName = list.name;
    this.listDescription = list.description ?? "";
  }
}

function normalizeListName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
