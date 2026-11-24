"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ModelOption = { id: string; provider: string; providerLabel: string; model: string };

/** Short label for a model id: drop the vendor prefix NIM uses ("minimaxai/minimax-m3.1-flash" -> "minimax-m3.1-flash"). */
export const shortModel = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/**
 * The model picker under the message box: the current model as plain text; a click opens a
 * searchable list grouped by provider. Escape or a click outside closes it.
 */
export function ModelMenu(props: {
  models: ModelOption[];
  selected: string;
  defaultId: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const { models, selected, defaultId, disabled, onPick } = props;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Open toward the side with more room, never taller than that room (the prompt can sit mid-screen).
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: true, max: 460 });
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
        return;
      }
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    search.current?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byProvider = new Map<string, { label: string; items: ModelOption[] }>();
    for (const m of models) {
      if (q && !m.model.toLowerCase().includes(q) && !m.providerLabel.toLowerCase().includes(q)) continue;
      const g = byProvider.get(m.provider) ?? { label: m.providerLabel, items: [] };
      g.items.push(m);
      byProvider.set(m.provider, g);
    }
    return [...byProvider.values()];
  }, [models, filter]);

  const current = models.find((m) => m.id === selected);
  const label = current ? shortModel(current.model) : shortModel(selected.slice(selected.indexOf(":") + 1));

  return (
    <div className="model-menu" ref={root}>
      <button
        type="button"
        className="model-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the model that writes the answers"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const above = r.top - 24;
          const below = window.innerHeight - r.bottom - 24;
          setPlace({ up: above >= Math.min(460, below), max: Math.max(200, Math.min(460, Math.max(above, below))) });
          setOpen((o) => !o);
          setFilter("");
        }}
      >
        <span className={`model-dot p-${current?.provider ?? "x"}`} aria-hidden />
        <span className="model-name">{label}</span>
        {current && <span className="model-provider">{current.providerLabel}</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={`model-pop${place.up ? "" : " down"}`} style={{ maxHeight: place.max }} role="listbox" aria-label="Models">
          <input ref={search} className="model-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search models" aria-label="Search models" />
          <div className="model-list">
            {groups.length === 0 && <div className="model-empty">No models match “{filter.trim()}”</div>}
            {groups.map((g) => (
              <div key={g.label} className="model-group">
                <div className="model-group-label">{g.label}</div>
                {g.items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === selected}
                    className={`model-opt${m.id === selected ? " on" : ""}`}
                    onClick={() => (setOpen(false), m.id !== selected && onPick(m.id))}
                    title={m.model}
                  >
                    <span className="model-opt-name">{shortModel(m.model)}</span>
                    {m.model.includes("/") && <span className="model-opt-vendor">{m.model.slice(0, m.model.indexOf("/"))}</span>}
                    {m.id === defaultId && <span className="model-tag">default</span>}
                    {m.id === selected && (
                      <svg className="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
