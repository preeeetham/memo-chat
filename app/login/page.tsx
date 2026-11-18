"use client";

import { useEffect, useState } from "react";

/**
 * Sign-in. Password mode (default): email + password, or Google / GitHub icons when Firebase is set up. Dev mode: pick a username
 * (no password, local only). OIDC mode: continue with the identity provider.
 */
type FirebaseConfig = { apiKey: string; authDomain: string; projectId: string; appId: string };

function GoogleIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function Login() {
  type Mode = "dev" | "password" | "oidc";
  const [mode, setMode] = useState<Mode | null>(null);
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [firebase, setFirebase] = useState<FirebaseConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error"));
    void fetch("/api/auth/me").then(async (r) => {
      const body = (await r.json()) as { user: unknown; mode: Mode; firebase?: FirebaseConfig | null };
      if (r.ok && body.user) window.location.href = "/";
      else {
        setMode(body.mode);
        setFirebase(body.firebase ?? null);
      }
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

  /** Google / GitHub through Firebase: sign in with a popup, then trade the Firebase ID token for our session. */
  async function socialLogin(provider: "google" | "github") {
    if (!firebase) return;
    setBusy(true);
    setError(null);
    try {
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth, signInWithPopup, signOut, getAdditionalUserInfo, GoogleAuthProvider, GithubAuthProvider } = await import("firebase/auth");
      const app = getApps()[0] ?? initializeApp(firebase);
      const auth = getAuth(app);
      const p = provider === "google" ? new GoogleAuthProvider() : new GithubAuthProvider();
      if (provider === "github") p.addScope("user:email");
      const cred = await signInWithPopup(auth, p);
      const idToken = await cred.user.getIdToken();
      const username = getAdditionalUserInfo(cred)?.username ?? null; // GitHub login, used when there is no display name
      await signOut(auth).catch(() => {}); // our own session cookie takes over from here
      await post("/api/auth/firebase", { idToken, username });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      setError(
        code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request"
          ? null
          : code === "auth/account-exists-with-different-credential"
            ? "This email is already used with the other provider. Sign in with that one instead."
            : code === "auth/unauthorized-domain"
              ? "Google/GitHub sign-in isn't enabled for this website yet (Firebase authorized domains)."
              : code === "auth/popup-blocked"
              ? "Your browser blocked the sign-in popup. Allow popups for this site and try again."
              : `Sign-in failed (${code || "unknown error"}). Please try again.`,
      );
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
              {firebase && (
                <>
                  <div className="auth-or"><span>or</span></div>
                  <div className="auth-social">
                    <button type="button" className="social-icon" disabled={busy} onClick={() => void socialLogin("google")} aria-label="Sign in with Google" title="Sign in with Google">
                      <GoogleIcon />
                    </button>
                    <button type="button" className="social-icon" disabled={busy} onClick={() => void socialLogin("github")} aria-label="Sign in with GitHub" title="Sign in with GitHub">
                      <GitHubIcon />
                    </button>
                  </div>
                </>
              )}
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
