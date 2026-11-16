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
      <div className="card">
        <h1>Mini Chat</h1>
        <p>A chat agent that remembers your past conversations and checks the live web. Your history is private to your account.</p>
        {mode === "oidc" && <a className="primary" href="/api/auth/login">Continue to sign in</a>}
        {mode === "dev" && (
          <form onSubmit={devLogin} style={{ display: "grid", gap: 10 }}>
            <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username, e.g. demo" aria-label="Username" />
            <button type="submit" disabled={busy || !username.trim()}>Sign in</button>
            <span className="hint">
              Development sign-in: no password, any username. Use <strong>demo</strong> to see the preloaded demo history. Set AUTH_MODE=oidc to use a real identity provider.
            </span>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
