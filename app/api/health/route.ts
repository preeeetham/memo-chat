import { sys } from "../../../src/db/index";
import { soft } from "../../../src/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness: Postgres is required, Redis is reported (the app degrades without it). */
export async function GET(): Promise<Response> {
  let postgres = false;
  try {
    await sys("SELECT 1");
    postgres = true;
  } catch {}
  const redis = (await soft((r) => r.ping(), "down")) === "PONG";
  return Response.json({ ok: postgres, postgres, redis }, { status: postgres ? 200 : 503 });
}
