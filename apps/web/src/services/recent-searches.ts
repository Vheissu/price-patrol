const STORAGE_KEY = "pp-recent-searches";
const MAX_ENTRIES = 8;

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function recordRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) {
    return;
  }

  try {
    const next = [trimmed, ...getRecentSearches().filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase())];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable, skip persistence.
  }
}
