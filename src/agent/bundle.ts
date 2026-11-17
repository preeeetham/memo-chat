/** Render the per-turn context note: current time, resolved dates, and recalled records. */
import { shortLabel } from "../time/local";
import type { EvidenceBundle } from "./recall";

const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${shortLabel(d)} ${d.slice(0, 4)}` : d);

export function renderContext(nowLine: string, b: EvidenceBundle): string {
  const lines: string[] = [
    `Current date and time for the user: ${nowLine}.`,
    // Small models fall back to "I have no memory between sessions"; restate the truth every turn.
    "You DO have memory of this user's earlier chats: the [M#] records in this and earlier context notes come from it. If asked how you knew something from an earlier chat, say you recalled it from your memory of that conversation (give its date and [M#]); never say chats or sessions start fresh.",
  ];
  if (b.resolved.length) {
    lines.push(`Resolved dates: ${b.resolved.map((r) => `"${r.expr}" = ${r.date.includes("..") ? r.date.replace("..", " to ") : day(r.date)}`).join("; ")}.`);
  }
  if (b.status === "not_needed") return lines.join("\n");

  lines.push(`Memory lookup: ${b.status}.${b.note ? ` ${b.note}` : ""}`);
  if (b.status === "none") {
    lines.push(
      b.history_span
        ? `No matching past conversation. The stored history covers ${day(b.history_span.first)} to ${day(b.history_span.last)}.`
        : "No past conversations are stored yet.",
    );
    if (b.nearest?.length) lines.push(`Closest records: ${b.nearest.map((n) => `${day(n.local_date)}: "${n.question}"`).join("; ")}.`);
    return lines.join("\n");
  }

  lines.push("Records from past conversations (these are exactly what was said; cite them as [M1], [M2], ...):");
  for (const t of b.turns) {
    lines.push(`\n[${t.ref}] ${day(t.local_date)} — conversation "${t.conversation_title}"`);
    lines.push(`User asked: ${t.question}`);
    lines.push(`You answered: ${t.answer_excerpt}`);
    if (t.claims.length) {
      lines.push("Claims recorded from that answer:");
      for (const c of t.claims) {
        lines.push(`- ${c.subject} | ${c.attribute} | ${c.value} | seen ${c.observed_at}${c.source_url ? ` | ${c.source_url}` : ""}`);
        if (c.evidence_excerpt) lines.push(`  page text then: "${c.evidence_excerpt.replace(/\s+/g, " ")}"`);
      }
    }
  }
  lines.push(
    "\nIf the user asks whether this is still true or what changed: check each claim with web_search now, then label each item still correct [S#] / changed [S#] / couldn't verify. Never call something unchanged without a current source that shows the same value.",
  );
  return lines.join("\n");
}
