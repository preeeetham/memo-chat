import { fakeNowActive, now, setFakeNow } from "../../../src/clock";
import { config, missingConfig } from "../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const c = config();
  return Response.json({
    problems: missingConfig(c),
    model: c.llm.model,
    helperModel: c.llm.helperModel,
    searchProvider: c.search.provider,
    now: now().toISOString(),
    fakeNow: fakeNowActive(),
  });
}

/** Dev only: freeze the clock to test relative dates ("last Tuesday") against seeded history. */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { fakeNow?: string | null };
  setFakeNow(body.fakeNow || null);
  return Response.json({ now: now().toISOString(), fakeNow: fakeNowActive() });
}
