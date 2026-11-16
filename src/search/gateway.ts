/**
 * The search gateway wraps a provider with what many users need:
 * - a shared query cache in Redis (results are public web content, so sharing across users is fine;
 *   each user still gets their own web_evidence rows),
 * - request coalescing (identical in-flight queries in this process share one provider call),
 * - provider fallback (SEARCH_FALLBACK_PROVIDER, e.g. Exa -> Tavily).
 */
import { createHash } from "node:crypto";
import { cacheGet, cacheSet, key } from "../redis";
import type { SearchProvider, SearchRequest, SearchResult } from "./provider";

const inflight = new Map<string, Promise<SearchResult[]>>();

/** Cache lifetime: page reads (pricing pages) 1 hour, filtered news searches 15 minutes. */
const ttlFor = (req: SearchRequest) => (req.readPages ? 3600 : 900);

export function cachedProvider(inner: SearchProvider): SearchProvider {
  return {
    name: inner.name,
    async search(req: SearchRequest): Promise<SearchResult[]> {
      const norm = { q: req.query.trim().toLowerCase().replace(/\s+/g, " "), s: req.since ?? null, d: [...(req.domains ?? [])].sort(), r: Boolean(req.readPages), n: req.numResults };
      const k = key("search", inner.name, createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 32));
      const hit = await cacheGet<SearchResult[]>(k);
      if (hit) return hit;
      const running = inflight.get(k);
      if (running) return running;
      const p = inner
        .search(req)
        .then(async (results) => {
          if (results.length) await cacheSet(k, results, ttlFor(req));
          return results;
        })
        .finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    },
  };
}

export function withFallback(primary: SearchProvider, secondary: SearchProvider | null): SearchProvider {
  if (!secondary) return primary;
  return {
    get name() {
      return primary.name;
    },
    async search(req: SearchRequest): Promise<SearchResult[]> {
      try {
        return await primary.search(req);
      } catch (err) {
        console.warn(`[search] ${primary.name} failed (${(err as Error).message.slice(0, 100)}); trying ${secondary.name}`);
        return secondary.search(req);
      }
    },
  };
}
