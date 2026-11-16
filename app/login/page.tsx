"use client";

import { useEffect, useState } from "react";

/** Sign-in. Dev mode: pick a username (no password, local only). OIDC mode: continue with the identity provider. */
export default function Login() {
  const [mode, setMode] = useState<"dev" | "oidc" | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error"));
    void fetch("/api/auth/me").then(async (r) => {
      const body = (await r.json()) as { user: unknown; mode: "dev" | "oidc" };
      if (r.ok && body.user) window.location.href = "/";
      else setMode(body.mode);
    });
  }, []);

  async function devLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
    if (r.ok) window.location.href = "/";
    else {
      setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <nav className="login-nav">
        <span className="brand"><span className="brand-mark" aria-hidden />Mini Chat</span>
      </nav>
      <main className="login-main">
        <section>
          <h1>
            Answers that <span className="accent">remember</span> what you asked
          </h1>
          <p className="lede">
            Mini Chat recalls your past conversations by date, rechecks the live web, and tells you what changed since. Your history is private to your account.
          </p>

          {mode === "oidc" && (
            <a className="btn btn-ink btn-lg" href="/api/auth/login">Continue to sign in</a>
          )}
          {mode === "dev" && (
            <form onSubmit={devLogin}>
              <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username, e.g. demo" aria-label="Username" autoComplete="username" />
              <button type="submit" className="btn btn-ink btn-lg" disabled={busy || !username.trim()}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <div className="hint">
                Development sign-in: no password, any username. Use <strong>demo</strong> to see the preloaded history. Set <code>AUTH_MODE=oidc</code> for a real identity provider.
              </div>
            </form>
          )}
          {error && <div className="error">{error}</div>}

          <div className="login-points">
            <div><b>1.</b>“Last Tuesday” becomes a real date, in your timezone.</div>
            <div><b>2.</b>The matching conversation is recalled, with what was said then.</div>
            <div><b>3.</b>Each claim is rechecked live: changed, still correct, or unverified.</div>
          </div>
        </section>

        <section className="preview" aria-label="Example of a recalled answer">
          <div className="bubble">Last Tuesday I asked about Postgres hosting. Has pricing changed since?</div>
          <div className="panel">
            <div className="line">
              <span className="ctx-label"><i className="i-date" />Read as</span>
              <span className="resolved"><q>Last Tuesday</q><span className="arrow">→</span><strong>Tue 10 Nov</strong></span>
            </div>
            <div className="line">
              <span className="ctx-label"><i className="i-mem" />Recalled</span>
              <span><span className="recall" style={{ cursor: "default" }}><span className="ref">M1</span><span className="t">Postgres hosting prices</span></span></span>
            </div>
            <div className="line">
              <span className="ctx-label"><i className="i-web" />Rechecked</span>
              <span className="muted">Live today · 7 sources</span>
            </div>
          </div>
          <div className="panel rows">
            <div><span>Neon Launch</span><span className="verdict changed">Changed</span></div>
            <div><span>Supabase Pro</span><span className="verdict same">Still correct</span></div>
            <div><span>AWS RDS t4g.micro</span><span className="verdict same">Still correct</span></div>
          </div>
          <div className="caption">Illustration of a real answer</div>
        </section>
      </main>
    </div>
  );
}
