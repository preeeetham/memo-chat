"use client";

import { useEffect, useState } from "react";

/**
 * Sign-in. Password mode (default): email + password, or continue as a guest. Dev mode: pick a username
 * (no password, local only). OIDC mode: continue with the identity provider.
 */
export default function Login() {
  type Mode = "dev" | "password" | "oidc";
  const [mode, setMode] = useState<Mode | null>(null);
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error"));
    void fetch("/api/auth/me").then(async (r) => {
      const body = (await r.json()) as { user: unknown; mode: Mode };
      if (r.ok && body.user) window.location.href = "/";
      else setMode(body.mode);
    });
  }, []);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) window.location.href = "/";
    else {
      setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Sign-in failed");
      setBusy(false);
    }
  }

  function devLogin(e: React.FormEvent) {
    e.preventDefault();
    void post("/api/auth/dev-login", { username });
  }

  function emailLogin(e: React.FormEvent) {
    e.preventDefault();
    void post(tab === "signin" ? "/api/auth/signin" : "/api/auth/signup", tab === "signin" ? { email, password } : { name, email, password });
  }

  return (
    <div className="login">
      <nav className="login-nav">
        <span className="brand"><span className="brand-mark" aria-hidden />Memo Chat</span>
      </nav>
      <main className="login-main">
        <section>
          <h1>
            Answers that <span className="accent">remember</span> what you asked
          </h1>
          <p className="lede">
            Memo Chat recalls your past conversations by date, rechecks the live web, and tells you what changed since. Your history is private to your account.
          </p>

          {mode === "oidc" && (
            <a className="btn btn-ink btn-lg" href="/api/auth/login">Continue to sign in</a>
          )}
          {mode === "password" && (
            <div className="auth">
              <div className="auth-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === "signin"} className={tab === "signin" ? "on" : ""} onClick={() => { setTab("signin"); setError(null); }}>
                  Sign in
                </button>
                <button type="button" role="tab" aria-selected={tab === "signup"} className={tab === "signup" ? "on" : ""} onClick={() => { setTab("signup"); setError(null); }}>
                  Create account
                </button>
              </div>
              <form onSubmit={emailLogin}>
                {tab === "signup" && (
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" autoComplete="name" maxLength={40} />
                )}
                <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" autoComplete="email" required />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={tab === "signup" ? "Password (8+ characters)" : "Password"}
                  aria-label="Password"
                  autoComplete={tab === "signup" ? "new-password" : "current-password"}
                  minLength={tab === "signup" ? 8 : undefined}
                  required
                />
                <button type="submit" className="btn btn-ink btn-lg" disabled={busy || !email.trim() || !password}>
                  {busy ? "Please wait…" : tab === "signin" ? "Sign in" : "Create account"}
                </button>
              </form>
              <div className="auth-or"><span>or</span></div>
              <button type="button" className="btn btn-line btn-lg auth-guest" disabled={busy} onClick={() => void post("/api/auth/guest", {})}>
                Continue as guest
              </button>
              <div className="hint">Guest chats are private but stay on this browser only. Create an account to keep them.</div>
            </div>
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
