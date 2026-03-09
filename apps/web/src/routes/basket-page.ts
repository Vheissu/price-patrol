import { customElement } from "aurelia";
import template from "./basket-page.html?raw";
import { apiClient, type BasketCompareResponse, type BasketLineInput, type CompareMode, type SavedListSummary } from "../services/api-client";

interface BasketRow extends BasketLineInput {
  quantity: number;
}

type ModeOption = {
  value: CompareMode;
  label: string;
  detail: string;
};

const DEFAULT_LIST_NAME = "Shopping list";

@customElement({ name: "basket-page", template })
export class BasketPage {
  readonly api = apiClient();
  readonly modeOptions: ModeOption[] = [
    {
      value: "equivalent",
      label: "Flexible match",
      detail: "Allows close equivalents and substitutes inside the basket."
    },
    {
      value: "exact",
      label: "Exact brand + pack",
      detail: "Keeps the basket closer to the exact products you wrote down."
    },
    {
      value: "best-value",
      label: "Best value",
      detail: "Optimizes by normalized value, even when pack sizes differ."
    }
  ];

  mode: CompareMode = "equivalent";
  postcode = "";
  suburb = "";
  isSubmitting = false;
  isSavingList = false;
  error = "";
  listMessage = "";
  basket?: BasketCompareResponse;
  draftItem = "";
  selectedListId = "";
  listName = DEFAULT_LIST_NAME;
  listDescription = "";
  savedLists: SavedListSummary[] = [];
  rows: BasketRow[] = [
    { id: crypto.randomUUID(), query: "plain flour", quantity: 1 },
    { id: crypto.randomUUID(), query: "full cream milk 2L", quantity: 1 },
    { id: crypto.randomUUID(), query: "eggs", quantity: 1 }
  ];

  async attached(): Promise<void> {
    await Promise.all([this.loadDefaultLocation(), this.refreshSavedLists()]);
  }

  get selectedModeDetail(): string {
    return this.modeOptions.find((option) => option.value === this.mode)?.detail ?? "";
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
    this.isSubmitting = true;
    this.error = "";

    try {
      this.basket = await this.api.compareBasket({
        mode: this.mode,
        postcode: this.postcode.trim() || undefined,
        suburb: this.suburb.trim() || undefined,
        items: this.rows.map((row) => ({ id: row.id, query: row.query, quantity: row.quantity }))
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to price this basket right now.";
      this.basket = undefined;
    } finally {
      this.isSubmitting = false;
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
