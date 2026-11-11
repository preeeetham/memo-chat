import { MAX_HIGHLIGHT_CHARS, MAX_PAGE_CHARS, isoDay, trimText, type SearchProvider, type SearchRequest, type SearchResult } from "./provider";

type TavilyResult = { url: string; title?: string; content?: string; raw_content?: string | null; published_date?: string | null };

/** Tavily search via its REST API (https://docs.tavily.com). */
export function tavilyProvider(apiKey: string): SearchProvider {
  return {
    name: "tavily",
    async search(req: SearchRequest): Promise<SearchResult[]> {
      const body: Record<string, unknown> = {
        query: req.query,
        max_results: req.numResults,
        search_depth: req.readPages ? "advanced" : "basic",
        include_raw_content: req.readPages ? "text" : false,
      };
      if (req.since) body.start_date = req.since;
      if (req.domains?.length) body.include_domains = req.domains;
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { results?: TavilyResult[] };
      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title?.trim() || r.url,
        publishedAt: isoDay(r.published_date),
        excerpt: req.readPages && r.raw_content ? trimText(r.raw_content, MAX_PAGE_CHARS) : trimText(r.content ?? "", MAX_HIGHLIGHT_CHARS),
      }));
    },
  };
}
