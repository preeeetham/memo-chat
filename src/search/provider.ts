/** Search provider interface. Exa is the default; Tavily and an offline mock implement the same shape. */

export type SearchRequest = {
  query: string;
  since?: string;          // YYYY-MM-DD: only results published on/after
  domains?: string[];      // restrict to these sites (primary sources)
  readPages?: boolean;     // return page text, not just highlights
  numResults: number;
  timeoutMs: number;
};

export type SearchResult = {
  url: string;
  title: string;
  publishedAt: string | null; // YYYY-MM-DD if the source states it
  excerpt: string;            // highlights or page text, already trimmed
};

export interface SearchProvider {
  name: string;
  search(req: SearchRequest): Promise<SearchResult[]>;
}

export const MAX_HIGHLIGHT_CHARS = 1200;
export const MAX_PAGE_CHARS = 3000;

export function trimText(s: string, max: number): string {
  const t = s.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function isoDay(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
