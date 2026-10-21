import { customElement } from "aurelia";
import template from "./price-chart.html?raw";
import type { ProductHistoryPoint } from "../services/api-client";

const WIDTH = 320;
const HEIGHT = 84;
const PAD_X = 6;
const PAD_TOP = 14;
const PAD_BOTTOM = 12;

interface ChartPoint {
  x: number;
  y: number;
  promo: boolean;
  last: boolean;
}

@customElement({
  name: "price-chart",
  template,
  bindables: ["points"]
})
export class PriceChart {
  points: ProductHistoryPoint[] = [];

  private get series(): ProductHistoryPoint[] {
    return [...this.points]
      .filter((point) => Number.isFinite(point.effectivePrice) && point.effectivePrice > 0)
      .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
  }

  get hasChart(): boolean {
    return this.series.length > 0;
  }

  get chartPoints(): ChartPoint[] {
    const series = this.series;
    if (!series.length) {
      return [];
    }

    const times = series.map((point) => new Date(point.observedAt).getTime());
    const prices = series.map((point) => point.effectivePrice);
    const minTime = times[0];
    const maxTime = times[times.length - 1];
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const timeSpan = Math.max(1, maxTime - minTime);
    const priceSpan = Math.max(0.01, maxPrice - minPrice);

    return series.map((point, index) => ({
      x: PAD_X + ((new Date(point.observedAt).getTime() - minTime) / timeSpan) * (WIDTH - PAD_X * 2),
      y: PAD_TOP + (1 - (point.effectivePrice - minPrice) / priceSpan) * (HEIGHT - PAD_TOP - PAD_BOTTOM),
      promo: Boolean(point.promotionText),
      last: index === series.length - 1
    }));
  }

  get linePath(): string {
    const points = this.chartPoints;
    if (!points.length) {
      return "";
    }
    if (points.length === 1) {
      return `M ${points[0].x} ${points[0].y}`;
    }
    return `M ${points.map((point) => `${round(point.x)} ${round(point.y)}`).join(" L ")}`;
  }

  get areaPath(): string {
    const points = this.chartPoints;
    if (points.length < 2) {
      return "";
    }
    const baseline = HEIGHT - PAD_BOTTOM;
    return `${this.linePath} L ${round(points[points.length - 1].x)} ${baseline} L ${round(points[0].x)} ${baseline} Z`;
  }

  get medianY(): number {
    const prices = this.series.map((point) => point.effectivePrice).sort((a, b) => a - b);
    if (!prices.length) {
      return HEIGHT / 2;
    }
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceSpan = Math.max(0.01, maxPrice - minPrice);
    return PAD_TOP + (1 - (median - minPrice) / priceSpan) * (HEIGHT - PAD_TOP - PAD_BOTTOM);
  }

  get highLabel(): string {
    const prices = this.series.map((point) => point.effectivePrice);
    return prices.length ? `$${Math.max(...prices).toFixed(2)}` : "";
  }

  get lowLabel(): string {
    const prices = this.series.map((point) => point.effectivePrice);
    return prices.length ? `$${Math.min(...prices).toFixed(2)}` : "";
  }

  get highLabelY(): number {
    return Math.min(...this.chartPoints.map((point) => point.y)) + 2;
  }

  get lowLabelY(): number {
    return Math.max(...this.chartPoints.map((point) => point.y)) + 2;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
