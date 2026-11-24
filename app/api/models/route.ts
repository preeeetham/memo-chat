import { withUser } from "../../../src/auth";
import { getChatModel, setChatModel } from "../../../src/db/repo";
import { defaultChatModel, listModels, parseChatModel } from "../../../src/llm/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The chat models this user can pick from every configured endpoint, the default, and their current choice. */
export async function GET(req: Request): Promise<Response> {
  return withUser(req, async () => {
    const [models, saved] = await Promise.all([listModels(), getChatModel()]);
    const def = defaultChatModel().ref;
    const selected = parseChatModel(saved)?.ref ?? def;
    return Response.json({ models, default: def, selected });
  });
}

/** Pick the chat model for this user: {"model": "nim:minimaxai/minimax-m3.1-flash"}; null or the default resets it. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    const def = defaultChatModel().ref;
    const ref = typeof body.model === "string" && body.model !== def ? body.model : null;
    if (ref && !(await listModels()).some((m) => m.id === ref)) return Response.json({ error: `Unknown model "${ref}".` }, { status: 400 });
    await setChatModel(ref);
    return Response.json({ selected: ref ?? def });
  });
}
