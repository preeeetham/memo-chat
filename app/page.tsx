"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Source = { ref: string; url: string; title: string; publishedAt: string | null; retrievedAt: string };
type Recalled = { ref: string; local_date: string; conversation_id: string; conversation_title: string | null };
type Msg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  local_date?: string;
  sources: Source[];
  memory: { status: string; resolved: Array<{ expr: string; date: string }>; recalled: Recalled[] } | null;
  timings?: Record<string, number> | null;
  degraded?: string | null;
  error?: string;
};
type Conv = { id: string; title: string | null; updated_at: string; last_local_date: string | null };
type Settings = {
  problems: string[];
  model: string;
  searchProvider: string;
  now: string;
  fakeNow: string | null;
  demoTools: boolean;
  user: { id: string; name: string | null; guest?: boolean };
  welcomed?: boolean;
  preferredName?: string | null;
  budget: { dailyTokens: number; usedToday: number };
};

/** fetch that sends the user to sign-in when the session is missing or expired. */
async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("signed out");
  }
  return res;
}

/** Read an SSE body, calling onEvent(seq, event) per event. Resolves when the stream ends. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (seq: number, e: Record<string, any>) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const lines = raw.split("\n");
      const data = lines.find((l) => l.startsWith("data: "));
      const id = lines.find((l) => l.startsWith("id: "));
      if (data) onEvent(id ? Number(id.slice(4)) : 0, JSON.parse(data.slice(6)));
    }
  }
}

/** First-visit welcome: what the product does, shown once per user. */
const WELCOME_POINTS = [
  { title: "Live answers with sources", text: "Ask about anything current. I search the web and cite what I used." },
  { title: "Memory across chats", text: "Refer back by topic or date, like “what did I ask last Tuesday?”, and I’ll find it." },
  { title: "What changed since", text: "Ask me to recheck an earlier answer and I’ll mark each point as changed or still correct." },
];

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** "2026-11-10" -> "Tue 10 Nov" (adds the year when it isn't this year). */
function fmtDate(d: string, today: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(x.getTime())) return d;
  const sameYear = d.slice(0, 4) === today.slice(0, 4);
  return x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The answer labels each rechecked claim "Changed", "Still correct" or "Couldn't verify" (see src/agent/prompt.ts). */
type Verdict = "changed" | "same" | "unknown";
const VERDICT_RE = /^(changed|still correct|unchanged|couldn['’]?t verify|could not verify|not verified|unverified)\b/i;
function verdictOf(label: string): Verdict | null {
  const m = label.trim().match(VERDICT_RE);
  if (!m) return null;
  const w = (m[1] ?? "").toLowerCase();
  if (w === "changed") return "changed";
  if (w === "still correct" || w === "unchanged") return "same";
  return "unknown";
}
function tallyVerdicts(text: string): Record<Verdict, number> {
  const t: Record<Verdict, number> = { changed: 0, same: 0, unknown: 0 };
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) {
    const v = verdictOf(m[1] ?? "");
    if (v) t[v]++;
  }
  return t;
}
function plainText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (typeof node === "object" && "props" in node) return plainText((node.props as { children?: React.ReactNode }).children);
  return "";
}

function dayLabel(d: string | null, today: string): string {
  if (!d) return "Earlier";
  if (d === today) return "Today";
  const x = new Date(`${d}T00:00:00Z`);
  const y = new Date(`${today}T00:00:00Z`);
  const diff = Math.round((y.getTime() - x.getTime()) / 86_400_000);
  if (diff === 1) return "Yesterday";
  return x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function localToday(nowIso: string | undefined): string {
  const d = nowIso ? new Date(nowIso) : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Turn [S2] / [M1] markers into links the markdown renderer understands. */
function linkCitations(text: string, m: Msg): string {
  const byRef = new Map(m.sources.map((s) => [s.ref, s]));
  const mem = new Map((m.memory?.recalled ?? []).map((r) => [r.ref, r]));
  // Attach markers to the word before them and to each other: "price [S4] [S6] ." -> "price[S4][S6]."
  const tight = text.replace(/[ \t]+(?=\[(?:S|M)\d+(?:\s*,\s*(?:S|M)\d+)*\])/g, "").replace(/(\[(?:S|M)\d+(?:\s*,\s*(?:S|M)\d+)*\])[ \t]+(?=[.,;:!?)])/g, "$1");
  return tight.replace(/\[((?:S|M)\d+)(?:\s*,\s*((?:S|M)\d+))*\]/g, (all) => {
    const refs = all.slice(1, -1).split(/\s*,\s*/);
    return refs
      .map((ref) => {
        const s = byRef.get(ref);
        if (s) return `[${ref}](${s.url} "cite")`;
        const r = mem.get(ref);
        if (r) return `[${ref}](#conv:${r.conversation_id} "cite")`;
        return `[${ref}]`;
      })
      .join(""); // adjacent markers: spacing comes from CSS, so they stay tight
  });
}

export default function Page() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [fakeNowInput, setFakeNowInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [userTz, setUserTz] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const turnRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const loadConvs = useCallback(async () => {
    const r = await api("/api/conversations").then((x) => x.json());
    setConvs(r.conversations ?? []);
  }, []);
  const loadSettings = useCallback(async () => {
    const s = (await api("/api/settings").then((x) => x.json())) as Settings;
    setSettings(s);
    setFakeNowInput(s.fakeNow ?? "");
    // Show the welcome on this visit only, and record it so it never comes back (on any device).
    if (s.welcomed === false) {
      setWelcome(true);
      void api("/api/welcome", { method: "POST" });
    }
  }, []);
  const openConv = useCallback(async (id: string) => {
    setSidebarOpen(false);
    const r = await api(`/api/conversations/${id}`).then((x) => x.json());
    if (r.error) return;
    setActiveId(id);
    setMessages(r.messages);
  }, []);

  useEffect(() => {
    void loadConvs();
    void loadSettings();
    setUserTz(tz());
  }, [loadConvs, loadSettings]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  const today = localToday(settings?.now);
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Conv[] }> = [];
    for (const c of convs) {
      const label = dayLabel(c.last_local_date, today);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [convs, today]);

  function stopTurn() {
    if (turnRef.current) void fetch(`/api/chat/${turnRef.current}/stop`, { method: "POST" });
    abortRef.current?.abort();
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  function newChat() {
    stopTurn();
    setActiveId(null);
    setMessages([]);
    setStatus(null);
    setSidebarOpen(false);
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setWelcome(false);
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    const userMsg: Msg = { id: `tmp-u-${Date.now()}`, role: "user", text: t, sources: [], memory: null };
    const asst: Msg = { id: `tmp-a-${Date.now()}`, role: "assistant", text: "", sources: [], memory: null };
    setMessages((m) => [...m, userMsg, asst]);
    let curId = asst.id; // becomes the server's id when the turn is done
    // Capture the id when the update is queued: React runs updaters later, after curId may have
    // changed to the server's id, and an updater reading curId then would match nothing (stuck answer).
    const update = (fn: (a: Msg) => Msg) => {
      const id = curId;
      setMessages((ms) => ms.map((x) => (x.id === id ? fn(x) : x)));
    };

    // Smooth streaming: the model sends text in bursts; reveal it at a steady pace instead.
    // Each frame shows a slice of what has arrived but isn't on screen yet, so bursts flow in
    // and the display never falls far behind.
    let received = "";
    let shown = 0;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const backlog = received.length - shown;
      if (backlog <= 0) return;
      shown = Math.min(received.length, shown + Math.max(2, Math.ceil(backlog / 24)));
      const text = received.slice(0, shown);
      update((a) => ({ ...a, text }));
      raf = requestAnimationFrame(tick);
    };
    const pump = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    turnRef.current = null;
    let lastSeq = 0;
    let finished = false;
    const onEvent = (seq: number, e: Record<string, any>) => {
      if (seq) lastSeq = seq;
      if (e.type === "start") {
        turnRef.current = e.assistantMessageId;
        if (!activeRef.current) setActiveId(e.conversationId);
        activeRef.current = e.conversationId;
      } else if (e.type === "status") setStatus(e.text);
      else if (e.type === "memory") update((a) => ({ ...a, memory: { status: e.status, resolved: e.resolved, recalled: e.recalled } }));
      else if (e.type === "text") {
        setStatus(null);
        received += e.delta;
        pump();
      } else if (e.type === "sources") update((a) => ({ ...a, sources: [...a.sources, ...e.sources] }));
      else if (e.type === "done") {
        finished = true;
        update((a) => ({ ...a, id: e.assistantMessageId, timings: e.timings }));
        curId = e.assistantMessageId;
      } else if (e.type === "error") {
        finished = true;
        update((a) => ({ ...a, error: e.message }));
      }
    };
    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: activeRef.current, text: t, tz: tz() }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        update((a) => ({ ...a, error: err.error ?? "Request failed" }));
        return;
      }
      // The server keeps the turn running if the connection drops; resume from the last event we saw.
      for (let attempt = 0; ; attempt++) {
        try {
          await readEvents(attempt === 0 ? res.body : await resume(), onEvent);
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
        }
        if (finished || ctrl.signal.aborted || !turnRef.current || attempt >= 3) break;
        setStatus("Reconnecting…");
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (!finished && !ctrl.signal.aborted) update((a) => ({ ...a, error: "Connection lost. The answer is saved; reopen the conversation to see it." }));
    } catch (err) {
      if ((err as Error).name !== "AbortError") update((a) => ({ ...a, error: "Connection lost." }));
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;
      turnRef.current = null;
      void loadConvs();
    }

    async function resume(): Promise<ReadableStream<Uint8Array>> {
      const r = await api(`/api/chat/${turnRef.current}/events?after=${lastSeq}`, { signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error("resume failed");
      return r.body;
    }
  }

  async function loadDemo() {
    setStatus("Loading demo history…");
    await api("/api/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: tz() }) });
    setStatus(null);
    await loadConvs();
  }

  async function applyFakeNow(value: string | null) {
    await api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fakeNow: value }) });
    await loadSettings();
  }

  async function del(id: string) {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === activeId) newChat();
    await loadConvs();
  }

  const MdLink = ({ href, children, title }: { href?: string; children?: React.ReactNode; title?: string }) => {
    if (href?.startsWith("#conv:")) {
      const id = href.slice(6);
      return (
        <a href={href} className="cite mem" title="Open the recalled conversation" onClick={(e) => (e.preventDefault(), void openConv(id))}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className={title === "cite" ? "cite" : undefined} title={title === "cite" ? hostOf(href ?? "") : title}>
        {children}
      </a>
    );
  };
  const MdStrong = ({ children }: { children?: React.ReactNode }) => {
    const plain = plainText(children);
    if (/^[\s,]*(?:\[?[SM]\d+\]?[\s,]*)+$/.test(plain)) return <>{children}</>; // never bold a citation
    const v = verdictOf(plain);
    return v ? <span className={`verdict ${v}`}>{children}</span> : <strong>{children}</strong>;
  };
  const mdComponents = { a: MdLink, strong: MdStrong };

  function renderContext(m: Msg) {
    // Memory context only when something was actually recalled.
    const mem = m.memory && m.memory.recalled.length > 0 ? m.memory : null;
    const tally = m.text ? tallyVerdicts(m.text) : { changed: 0, same: 0, unknown: 0 };
    const checked = tally.changed + tally.same + tally.unknown;
    const since = mem?.recalled[0]?.local_date ?? mem?.resolved[0]?.date;
    if (!mem && !checked) return null;
    return (
      <div className="context">
        {mem && mem.resolved.length > 0 && (
          <div className="ctx-row">
            <span className="ctx-label"><i className="i-date" />Read as</span>
            <span className="ctx-body">
              {mem.resolved.map((r) => (
                <span key={r.expr} className="resolved" title={r.date}>
                  <q>{r.expr}</q><span className="arrow">→</span><strong>{fmtDate(r.date, today)}</strong>
                </span>
              ))}
            </span>
          </div>
        )}
        {mem && (
          <div className="ctx-row">
            <span className="ctx-label"><i className="i-mem" />Recalled</span>
            <span className="ctx-body">
              {mem.recalled.map((r) => (
                  <button key={r.ref} className="recall" title={`Open: ${r.conversation_title ?? ""}`} onClick={() => void openConv(r.conversation_id)}>
                    <span className="ref">{r.ref}</span>
                    <span className="t">{r.conversation_title ?? "Untitled"}</span>
                    <span className="d">{fmtDate(r.local_date, today)}</span>
                  </button>
              ))}
            </span>
          </div>
        )}
        {(checked > 0 || (mem && m.sources.length > 0)) && (
          <div className="ctx-row">
            <span className="ctx-label"><i className="i-web" />{since ? "Since" : "Rechecked"}</span>
            <span className="ctx-body">
              {since && <span>{fmtDate(since, today)} → today</span>}
              {checked > 0 ? (
                <span className="tally">
                  {tally.changed > 0 && <span className="verdict changed">{tally.changed} changed</span>}
                  {tally.same > 0 && <span className="verdict same">{tally.same} still correct</span>}
                  {tally.unknown > 0 && <span className="verdict unknown">{tally.unknown} couldn&apos;t verify</span>}
                </span>
              ) : (
                <span className="muted">Rechecked live</span>
              )}
              {m.sources.length > 0 && <span className="muted">{m.sources.length} sources read</span>}
            </span>
          </div>
        )}
      </div>
    );
  }

  const budgetPct = settings && settings.budget.dailyTokens > 0 ? Math.min(100, Math.round((settings.budget.usedToday / settings.budget.dailyTokens) * 100)) : null;
  const userName = settings ? settings.preferredName ?? settings.user.name ?? settings.user.id : "";
  const greetName = settings?.preferredName ?? null;

  async function finishWelcome() {
    const name = nameInput.trim();
    setWelcome(false);
    if (name) {
      setSettings((s) => (s ? { ...s, preferredName: name.slice(0, 40) } : s));
      await api("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    }
  }

  return (
    <div className="app">
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <header>
          <span className="brand"><span className="brand-mark" aria-hidden />Memo Chat</span>
          <button className="btn btn-ink" onClick={newChat}>New chat</button>
        </header>
        <nav className="conv-list">
          {convs.length === 0 && <div className="conv-empty">No conversations yet.</div>}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="group-label">{g.label}</div>
              {g.items.map((c) => (
                <div key={c.id} className={`conv${c.id === activeId ? " active" : ""}`}>
                  <button className="open" title={c.title ?? ""} onClick={() => void openConv(c.id)}>
                    {c.title ?? "New chat"}
                  </button>
                  <button className="del" aria-label="Delete conversation" onClick={() => void del(c.id)}>×</button>
                </div>
              ))}
            </div>
          ))}
        </nav>
        <footer>
          {settings && (
            <div className="who">
              <span className="avatar" aria-hidden>{userName.replace(/^.*\|/, "").slice(0, 1)}</span>
              <span className="name">{userName}</span>
              <button className="link-btn" onClick={() => void signOut()}>Sign out</button>
            </div>
          )}
          {budgetPct !== null && (
            <div className="budget" title="Your daily token budget">
              <div className={`budget-bar${budgetPct >= 80 ? " high" : ""}`}><span style={{ width: `${budgetPct}%` }} /></div>
              <span>{budgetPct}% of today&apos;s budget used</span>
            </div>
          )}
          <div className="engine">
            {settings ? `${settings.model} · search: ${settings.searchProvider}` : "…"}
            {settings?.demoTools && (
              <>
                {" "}· <button className="link-btn" onClick={() => setShowSettings((s) => !s)}>{showSettings ? "hide demo tools" : "demo tools"}</button>
              </>
            )}
          </div>
          {showSettings && (
            <div className="settings">
              <span className="demo-tag">Demo / testing only. The clock is shared by everyone on this server.</span>
              <div className="row">
                <button className="btn btn-line" onClick={() => void loadDemo()}>Load demo history</button>
              </div>
              <label>
                Fake clock (ISO time, empty = real time)
                <input value={fakeNowInput} placeholder="2026-11-11T14:05:00+05:30" onChange={(e) => setFakeNowInput(e.target.value)} />
              </label>
              <div className="row">
                <button className="btn btn-ink" onClick={() => void applyFakeNow(fakeNowInput || null)}>Set clock</button>
                <button className="btn btn-line" onClick={() => void applyFakeNow(null)}>Real time</button>
              </div>
              {settings?.fakeNow && <span className="demo-tag">Clock frozen at {settings.fakeNow}</span>}
            </div>
          )}
        </footer>
      </aside>

      <main className="main">
        {settings && settings.problems.length > 0 && (
          <div className="banner">
            Setup needed: {settings.problems.join(" ")} Copy <code>.env.example</code> to <code>.env</code>, fill it in, and restart (<code>docker compose up</code> or <code>npm run dev</code>).
          </div>
        )}
        <div className="topbar">
          <button className="btn btn-line" onClick={() => setSidebarOpen((s) => !s)} aria-label="Show conversations">☰ Chats</button>
          <span className="brand"><span className="brand-mark" aria-hidden />Memo Chat</span>
          <button className="btn btn-ink" onClick={newChat}>New</button>
        </div>
        <div className="messages" ref={scrollRef} onClick={() => sidebarOpen && setSidebarOpen(false)}>
          {messages.length === 0 ? (
            welcome ? (
              <div className="empty welcome">
                <h1>{greetName ? `Welcome, ${greetName}` : "Welcome to Memo Chat"}</h1>
                <p className="lede">A research assistant that remembers your conversations and keeps its answers current.</p>
                <div className="welcome-points">
                  {WELCOME_POINTS.map((p) => (
                    <div key={p.title} className="welcome-point">
                      <div className="t">{p.title}</div>
                      <div className="d">{p.text}</div>
                    </div>
                  ))}
                </div>
                {!greetName && (
                  <form className="welcome-name" onSubmit={(e) => (e.preventDefault(), void finishWelcome())}>
                    <label htmlFor="welcome-name">What should I call you?</label>
                    <input id="welcome-name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" maxLength={40} autoComplete="given-name" />
                  </form>
                )}
                <div className="welcome-foot">
                  <span className="muted">
                    {settings?.user.guest
                      ? "You’re using a guest account: chats stay on this browser. Create an account to keep them."
                      : "Your history is private to your account."}
                  </span>
                  <button className="btn btn-ink" onClick={() => void finishWelcome()}>Get started</button>
                </div>
              </div>
            ) : (
              <div className="empty quiet">
                <span className="brand-mark" aria-hidden />
                <h2>{greetName ? `Welcome back, ${greetName}` : "Welcome back"}</h2>
                <p className="muted">How can I help you today?</p>
              </div>
            )
          ) : (
            <div className="thread">
              {messages.map((m, idx) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === "user" ? (
                    m.text
                  ) : (
                    <>
                      {renderContext(m)}
                      {busy && idx === messages.length - 1 && status && (
                        <div className="status"><span className="dot" />{status}</div>
                      )}
                      {m.text && (
                        <div className="md">
                          <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={mdComponents}>
                            {linkCitations(m.text, m)}
                          </ReactMarkdown>
                        </div>
                      )}
                      {m.error && <div className="error">{m.error}</div>}
                      {m.degraded && <div className="fallback" title="The main model was unavailable">Answered by fallback model {m.degraded}</div>}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="composer">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              rows={1}
              placeholder="Ask anything…"
              aria-label="Message"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn btn-line" onClick={stopTurn}>Stop</button>
            ) : (
              <button type="submit" className="btn btn-ink" disabled={!input.trim()}>Send</button>
            )}
          </form>
          <div className="hint">Dates are read in your timezone ({userTz}). Enter to send, Shift+Enter for a new line.</div>
        </div>
      </main>
    </div>
  );
}
