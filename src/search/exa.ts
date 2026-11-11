import { MAX_HIGHLIGHT_CHARS, MAX_PAGE_CHARS, isoDay, trimText, type SearchProvider, type SearchRequest, type SearchResult } from "./provider";

type ExaResult = { url: string; title?: string | null; publishedDate?: string | null; text?: string; highlights?: string[] };

/** Exa search via its REST API (https://docs.exa.ai). Plain fetch keeps the dependency surface small. */
export function exaProvider(apiKey: string): SearchProvider {
  return {
    name: "exa",
    async search(req: SearchRequest): Promise<SearchResult[]> {
      const body: Record<string, unknown> = {
        query: req.query,
        type: "auto",
        numResults: req.numResults,
        contents: req.readPages
          ? { text: { maxCharacters: MAX_PAGE_CHARS }, maxAgeHours: 24 } // pricing pages: fresh copy of the page
          : { highlights: { numSentences: 4, highlightsPerUrl: 3 } },
      };
      if (req.since) body.startPublishedDate = `${req.since}T00:00:00.000Z`;
      if (req.domains?.length) body.includeDomains = req.domains;

      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { results?: ExaResult[] };
      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title?.trim() || r.url,
        publishedAt: isoDay(r.publishedDate),
        excerpt: req.readPages
          ? trimText(r.text ?? "", MAX_PAGE_CHARS)
          : trimText((r.highlights?.length ? r.highlights.join(" … ") : r.text) ?? "", MAX_HIGHLIGHT_CHARS),
      }));
    },
  };
}
