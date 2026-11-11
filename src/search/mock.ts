import type { SearchProvider, SearchRequest, SearchResult } from "./provider";

/**
 * Offline provider for tests and keyless evals (SEARCH_PROVIDER=mock). Returns a deterministic,
 * clearly-labelled fake result so the pipeline can run without network. Never the default.
 */
export function mockProvider(): SearchProvider {
  return {
    name: "mock",
    async search(req: SearchRequest): Promise<SearchResult[]> {
      const host = req.domains?.[0] ?? "example.com";
      return [
        {
          url: `https://${host}/mock?q=${encodeURIComponent(req.query)}`,
          title: `[MOCK] ${req.query}`,
          publishedAt: req.since ?? null,
          excerpt: `Mock search result for "${req.query}". This is offline test data, not real web content.`,
        },
      ];
    },
  };
}
