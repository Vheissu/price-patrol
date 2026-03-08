import { customElement } from "aurelia";
import template from "./basket-page.html?raw";
import { apiClient, type BasketCompareResponse, type BasketLineInput, type CompareMode } from "../services/api-client";

interface BasketRow extends BasketLineInput {
  quantity: number;
}

@customElement({ name: "basket-page", template })
export class BasketPage {
  readonly api = apiClient();
  readonly modes: CompareMode[] = ["equivalent", "exact", "best-value"];

  mode: CompareMode = "equivalent";
  postcode = "";
  suburb = "";
  isSubmitting = false;
  error = "";
  basket?: BasketCompareResponse;
  draftItem = "";
  rows: BasketRow[] = [
    { id: crypto.randomUUID(), query: "plain flour", quantity: 1 },
    { id: crypto.randomUUID(), query: "full cream milk 2L", quantity: 1 },
    { id: crypto.randomUUID(), query: "eggs", quantity: 1 }
  ];

  async attached(): Promise<void> {
    await this.loadDefaultLocation();
    await this.compareBasket();
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

  async addRow(): Promise<void> {
    const query = this.draftItem.trim();
    if (!query) {
      return;
    }
    this.rows = [...this.rows, { id: crypto.randomUUID(), query, quantity: 1 }];
    this.draftItem = "";
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
}
