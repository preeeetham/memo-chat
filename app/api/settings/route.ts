import { withUser } from "../../../src/auth";
import { tokensUsedToday } from "../../../src/budget";
import { fakeNowActive, now, setFakeNow } from "../../../src/clock";
import { config, missingConfig } from "../../../src/config";
import { getPreferredName, isWelcomed } from "../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return withUser(req, async (user) => {
    const c = config();
    return Response.json({
      problems: missingConfig(c),
      model: c.llm.model,
      helperModel: c.llm.helperModel,
      fallbackModel: c.llm.fallbackModel || null,
      searchProvider: c.search.provider,
      embeddings: c.embeddings.model || null,
      demoTools: c.demoTools,
      now: now().toISOString(),
      fakeNow: fakeNowActive(),
      user: { id: user.id, name: user.name, guest: user.id.startsWith("guest|") },
      welcomed: await isWelcomed(),
      preferredName: await getPreferredName(),
      budget: { dailyTokens: c.budgets.dailyTokens, usedToday: await tokensUsedToday(user.id) },
    });
  });
}

/** Demo only: freeze the clock to test relative dates ("last Tuesday") against seeded history. Process-wide. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    if (!config().demoTools) return Response.json({ error: "demo tools are off (DEMO_TOOLS=false)" }, { status: 403 });
    const body = (await req.json().catch(() => ({}))) as { fakeNow?: string | null };
    setFakeNow(body.fakeNow || null);
    return Response.json({ now: now().toISOString(), fakeNow: fakeNowActive() });
  });
}
