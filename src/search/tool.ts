/** The agent's one tool: web_search. Schema, execution, persistence and result formatting. */
import type { ChatCompletionFunctionTool } from "openai/resources";
import { z } from "zod";
import { now } from "../clock";
import { config } from "../config";
import { insertEvidence, insertSearchCall } from "../db/repo";
import { localDate } from "../time/local";
import { jsonSchemaOf } from "../llm/client";
import { exaProvider } from "./exa";
import { mockProvider } from "./mock";
import type { SearchProvider, SearchResult } from "./provider";
import { tavilyProvider } from "./tavily";

export const WebSearchInput = z.object({
  queries: z.array(z.string().min(2)).min(1).max(5).describe("1-5 focused queries, run in parallel. One per item for multi-item questions."),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("YYYY-MM-DD. Only results published on or after this date. Use for 'what changed since X'. null for no filter."),
  domains: z
    .array(z.string())
    .nullable()
    .describe("Restrict to these sites, e.g. [\"hubspot.com\"], to hit primary sources. null for the whole web."),
  read_pages: z
    .boolean()
    .describe("true returns up to ~3k characters of each page's text (use for pricing pages, changelogs). false returns short highlights."),
});
export type WebSearchInput = z.infer<typeof WebSearchInput>;

const DESCRIPTION = `Search the live web. This is your only tool.
- Pass several queries in one call for multi-item questions (one query per product/vendor); they run in parallel.
- For "what changed since <date>" set since to that date; results are then limited to pages published on/after it.
- For prices, plans and limits, read the vendor's own page: set domains to the vendor's site and read_pages to true (since is ignored then: you get the page as it is today). Prefer primary sources (vendor pricing pages, changelogs, official blogs, docs) over aggregators and SEO blogs.
- Each result has an id like [S3], a published date when the source states one, and the date it was retrieved. Cite results by id.`;

export const webSearchTool: ChatCompletionFunctionTool = {
  type: "function",
  function: { name: "web_search", description: DESCRIPTION, parameters: jsonSchemaOf(WebSearchInput), strict: true },
};

export type Source = { ref: string; url: string; title: string; publishedAt: string | null; retrievedAt: string; evidenceId: string };

export function searchProvider(): SearchProvider {
  const c = config().search;
  if (c.provider === "tavily") return tavilyProvider(c.tavilyKey);
  if (c.provider === "mock") return mockProvider();
  return exaProvider(c.exaKey);
}

/** Per-turn state: stable [S#] ids and URL de-duplication across all tool calls in the turn. */
export class SearchSession {
  readonly sources: Source[] = [];
  private byUrl = new Map<string, Source>();
  constructor(
    readonly assistantId: string,
    private tz: string = "UTC",
    private provider: SearchProvider = searchProvider(),
  ) {}

  /** Run one tool call. Returns the text for the tool result plus the new sources it introduced. */
  async run(input: WebSearchInput): Promise<{ text: string; newSources: Source[]; failed: number }> {
    const { resultsPerQuery, searchTimeoutMs } = config().limits;
    const retrievedAt = localDate(now(), this.tz);
    const domains = input.domains?.map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean) ?? [];
    const settled = await Promise.allSettled(
      input.queries.map(async (query) => {
        const results = await this.provider.search({
          query,
          // A pricing page read "as of today" must not be filtered out for lacking a recent publish date.
          since: input.read_pages ? undefined : (input.since ?? undefined),
          domains: domains.length ? domains : undefined,
          readPages: input.read_pages,
          numResults: resultsPerQuery,
          timeoutMs: searchTimeoutMs,
        });
        const callId = insertSearchCall({
          assistantId: this.assistantId,
          query,
          since: input.read_pages ? null : (input.since ?? null),
          domains: domains.length ? domains : null,
          provider: this.provider.name,
          at: now().toISOString(),
        });
        return { query, callId, results };
      }),
    );

    const blocks: string[] = [];
    const newSources: Source[] = [];
    let failed = 0;
    settled.forEach((s, i) => {
      const query = input.queries[i]!;
      if (s.status === "rejected") {
        failed++;
        blocks.push(`Query "${query}": failed (${String(s.reason?.message ?? s.reason).slice(0, 120)})`);
        return;
      }
      const lines: string[] = [];
      for (const r of s.value.results) {
        if (!r.excerpt) continue;
        const known = this.byUrl.get(r.url);
        const src = known ?? this.persist(s.value.callId, r, retrievedAt);
        if (!known) newSources.push(src);
        lines.push(formatResult(src, r));
      }
      blocks.push(`Query "${query}"${input.since && !input.read_pages ? ` (published since ${input.since})` : ""}:\n${lines.length ? lines.join("\n\n") : "(no results)"}`);
    });
    if (failed === input.queries.length) throw new Error(blocks.join("\n"));
    return { text: blocks.join("\n\n---\n\n"), newSources, failed };
  }

  private persist(callId: string, r: SearchResult, retrievedAt: string): Source {
    const ref = `S${this.sources.length + 1}`;
    const evidenceId = insertEvidence({
      search_call_id: callId,
      assistant_message_id: this.assistantId,
      ref,
      url: r.url,
      title: r.title,
      published_at: r.publishedAt,
      retrieved_at: retrievedAt,
      excerpt: r.excerpt,
    });
    const src: Source = { ref, url: r.url, title: r.title, publishedAt: r.publishedAt, retrievedAt, evidenceId };
    this.sources.push(src);
    this.byUrl.set(r.url, src);
    return src;
  }
}

function formatResult(src: Source, r: SearchResult): string {
  const host = (() => {
    try {
      return new URL(src.url).host.replace(/^www\./, "") + new URL(src.url).pathname.replace(/\/$/, "");
    } catch {
      return src.url;
    }
  })();
  return `[${src.ref}] ${src.title} — ${host} — published: ${src.publishedAt ?? "n/a"} — retrieved: ${src.retrievedAt}\n${r.excerpt}`;
}
