export function retailerLabel(retailer: string): string {
  if (retailer === "aldi") {
    return "ALDI";
  }
  if (retailer === "unmatched") {
    return "No match";
  }
  return retailer.charAt(0).toUpperCase() + retailer.slice(1);
}

export function retailerLogoUrl(retailer: string): string {
  return `/retailers/${retailer}.svg`;
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) {
    return "never";
  }

  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function shortDate(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
