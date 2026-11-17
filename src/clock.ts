import { config } from "./config";

// Kept on globalThis: Next.js may load this module once per route bundle.
const g = globalThis as unknown as { __memochatNow?: Date | null };

/** Current time. Honours MEMOCHAT_FAKE_NOW (dev/eval) and a runtime override (demo settings). */
export function now(): Date {
  const override = g.__memochatNow;
  if (override) return new Date(override);
  const fake = config().fakeNow;
  if (fake) {
    const d = new Date(fake);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function setFakeNow(iso: string | null): void {
  const d = iso ? new Date(iso) : null;
  g.__memochatNow = d && !Number.isNaN(d.getTime()) ? d : null;
}

export function fakeNowActive(): string | null {
  return g.__memochatNow?.toISOString() ?? config().fakeNow;
}
