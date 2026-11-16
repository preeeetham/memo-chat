import { clearCookie } from "../../../../src/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
}
