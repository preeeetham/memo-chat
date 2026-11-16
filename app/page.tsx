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
  user: { id: string; name: string | null };
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

const SUGGESTIONS = [
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
];

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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
  return text.replace(/\[((?:S|M)\d+)(?:\s*,\s*((?:S|M)\d+))*\]/g, (all) => {
    const refs = all.slice(1, -1).split(/\s*,\s*/);
    return refs
      .map((ref) => {
        const s = byRef.get(ref);
        if (s) return `[${ref}](${s.url} "cite")`;
        const r = mem.get(ref);
        if (r) return `[${ref}](#conv:${r.conversation_id} "cite")`;
        return `[${ref}]`;
      })
      .join(" ");
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
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    const userMsg: Msg = { id: `tmp-u-${Date.now()}`, role: "user", text: t, sources: [], memory: null };
    const asst: Msg = { id: `tmp-a-${Date.now()}`, role: "assistant", text: "", sources: [], memory: null };
    setMessages((m) => [...m, userMsg, asst]);
    const update = (fn: (a: Msg) => Msg) => setMessages((ms) => ms.map((x) => (x.id === asst.id ? fn(x) : x)));

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
        update((a) => ({ ...a, text: a.text + e.delta }));
      } else if (e.type === "sources") update((a) => ({ ...a, sources: [...a.sources, ...e.sources] }));
      else if (e.type === "done") {
        finished = true;
        update((a) => ({ ...a, id: e.assistantMessageId, timings: e.timings }));
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
        <a href={href} className="cite" onClick={(e) => (e.preventDefault(), void openConv(id))}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className={title === "cite" ? "cite" : undefined}>
        {children}
      </a>
    );
  };

  return (
    <div className="app">
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <header>
          <span className="brand">Mini Chat</span>
          <button className="new-btn" onClick={newChat}>New chat</button>
        </header>
        <nav className="conv-list">
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
              Signed in as <strong>{settings.user.name ?? settings.user.id}</strong> · <button onClick={() => void signOut()}>sign out</button>
              {settings.budget.dailyTokens > 0 && (
                <div title="Your daily token budget">
                  {Math.min(100, Math.round((settings.budget.usedToday / settings.budget.dailyTokens) * 100))}% of today&apos;s budget used
                </div>
              )}
            </div>
          )}
          <div>
            {settings ? `${settings.model} · search: ${settings.searchProvider}` : "…"}
            {settings?.demoTools && (
              <>
                {" "}· <button onClick={() => setShowSettings((s) => !s)}>{showSettings ? "hide demo tools" : "demo tools"}</button>
              </>
            )}
          </div>
          {showSettings && (
            <div className="settings">
              <span className="demo-tag">Demo / testing only. The clock is shared by everyone on this server.</span>
              <div className="row">
                <button onClick={() => void loadDemo()}>Load demo history</button>
              </div>
              <label>
                Fake clock (ISO time, empty = real time)
                <input value={fakeNowInput} placeholder="2026-11-11T14:05:00+05:30" onChange={(e) => setFakeNowInput(e.target.value)} />
              </label>
              <div className="row">
                <button onClick={() => void applyFakeNow(fakeNowInput || null)}>Set clock</button>
                <button onClick={() => void applyFakeNow(null)}>Real time</button>
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
        <button className="menu-btn" onClick={() => setSidebarOpen((s) => !s)}>☰ Conversations</button>
        <div className="messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="empty">
              <h1>What should we look into?</h1>
              <div>I remember our past conversations and check the live web. Try one of these (load the demo history first for the recall ones):</div>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread">
              {messages.map((m, idx) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === "user" ? (
                    m.text
                  ) : (
                    <>
                      {m.text && (
                        <div className="md">
                          <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={{ a: MdLink }}>
                            {linkCitations(m.text, m)}
                          </ReactMarkdown>
                        </div>
                      )}
                      {busy && idx === messages.length - 1 && status && (
                        <div className="status"><span className="dot" />{status}</div>
                      )}
                      {m.error && <div className="error">{m.error}</div>}
                      {m.degraded && <div className="meta"><span className="chip" title="The main model was unavailable">answered by fallback model {m.degraded}</span></div>}
                      {m.memory && m.memory.status !== "not_needed" && (
                        <div className="meta">
                          {m.memory.resolved.map((r) => (
                            <span key={r.expr} className="chip" title="How I read the date">{r.expr} → {r.date}</span>
                          ))}
                          {m.memory.status === "none" && <span className="chip">No matching past conversation</span>}
                          {m.memory.recalled.map((r) => (
                            <button key={r.ref} className="chip" title={r.conversation_title ?? ""} onClick={() => void openConv(r.conversation_id)}>
                              {r.ref} · {dayLabel(r.local_date, today)} · {(r.conversation_title ?? "").slice(0, 40)}
                            </button>
                          ))}
                        </div>
                      )}
                      {m.sources.length > 0 && (
                        <details className="sources" open={m.sources.length <= 6}>
                          <summary>{m.sources.length} sources</summary>
                          {m.sources.map((s) => (
                            <div key={s.ref} className="source">
                              <span className="ref">{s.ref}</span>
                              <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>{s.title}</a>
                              <span className="dates">
                                {(() => { try { return new URL(s.url).host.replace(/^www\./, ""); } catch { return ""; } })()}
                                {s.publishedAt ? ` · published ${s.publishedAt}` : ""} · retrieved {s.retrievedAt}
                              </span>
                            </div>
                          ))}
                        </details>
                      )}
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            {busy ? (
              <button type="button" onClick={stopTurn}>Stop</button>
            ) : (
              <button type="submit" disabled={!input.trim()}>Send</button>
            )}
          </form>
          <div className="hint">Times are read in your timezone ({userTz}). Enter to send, Shift+Enter for a new line.</div>
        </div>
      </main>
    </div>
  );
}
