/**
 * Demo history, backdated relative to now(), so recall can be tried without waiting a week.
 * The answers and page snapshots are illustrative demo data written for this repo (titles start with "[demo]"),
 * not real records; the live agent re-checks everything against the web.
 */
import { now } from "../clock";
import { db } from "../db/index";
import { deleteConversation } from "../db/repo";
import { addDays, localDate, weekday } from "../time/local";
import { importConversations, type ImportPayload } from "../memory/import";

/** UTC instant for a local date + time in tz (good to the minute; fine for demo data). */
function at(date: string, hhmm: string, tz: string): string {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const shown = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
  const offset = shown.getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

function previous(today: string, wd: number): string {
  let diff = (weekday(today) - wd + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, -diff);
}

function mostRecentNov3(today: string): string {
  const y = Number(today.slice(0, 4));
  const d = `${y}-11-03`;
  return d < today ? d : `${y - 1}-11-03`;
}

export function demoPayload(tz: string): ImportPayload {
  const today = localDate(now(), tz);
  const monday = previous(today, 1);
  const tuesday = previous(today, 2);
  const nov3 = mostRecentNov3(today);

  return {
    tz,
    conversations: [
      {
        title: "[demo] CRM shortlist for a 20-person sales team",
        messages: [
          {
            role: "user",
            created_at: at(monday, "10:12", tz),
            text: "We're a 20-person sales team moving off spreadsheets. Shortlist 5 CRM tools for us with their current per-seat pricing.",
          },
          {
            role: "assistant",
            created_at: at(monday, "10:13", tz),
            text: `Here's a shortlist of 5 CRMs that fit a 20-seat sales team, with list prices from each vendor's pricing page today:

| CRM | Plan that fits | Price (billed annually) |
|---|---|---|
| HubSpot Sales Hub | Professional | $90/seat/mo [S1] |
| Salesforce Sales Cloud | Pro Suite | $100/user/mo [S2] |
| Pipedrive | Professional | $49/seat/mo [S3] |
| Zoho CRM | Professional | $23/user/mo [S4] |
| Freshsales | Pro | $39/user/mo [S5] |

For 20 seats, Zoho is the cheapest (~$5.5k/yr) and Salesforce the most expensive (~$24k/yr). HubSpot is the easiest to adopt if you already use HubSpot Marketing.

As of ${monday}.`,
            sources: [
              { url: "https://www.hubspot.com/pricing/sales", title: "[demo snapshot] HubSpot Sales Hub pricing", published_at: null, excerpt: "Sales Hub Professional: $90/month per seat, billed annually. Includes forecasting, sequences, and playbooks." },
              { url: "https://www.salesforce.com/sales/pricing/", title: "[demo snapshot] Salesforce Sales Cloud pricing", published_at: null, excerpt: "Pro Suite: $100 USD/user/month (billed annually). Enterprise: $175 USD/user/month." },
              { url: "https://www.pipedrive.com/en/pricing", title: "[demo snapshot] Pipedrive pricing", published_at: null, excerpt: "Professional: $49 per seat/month billed annually. Includes AI sales assistant, automations." },
              { url: "https://www.zoho.com/crm/zohocrm-pricing.html", title: "[demo snapshot] Zoho CRM pricing", published_at: null, excerpt: "Professional: $23/user/month billed annually. Enterprise: $40/user/month billed annually." },
              { url: "https://www.freshworks.com/crm/pricing/", title: "[demo snapshot] Freshsales pricing", published_at: null, excerpt: "Pro: $39/user/month billed annually. Growth: $9/user/month billed annually." },
            ],
          },
          { role: "user", created_at: at(monday, "10:20", tz), text: "Great, let's keep all five on the shortlist for the trial." },
          {
            role: "assistant",
            created_at: at(monday, "10:20", tz),
            text: "Done: the shortlist is HubSpot Sales Hub, Salesforce Sales Cloud, Pipedrive, Zoho CRM and Freshsales. When you run trials, check seat minimums and annual-only discounts before comparing totals.",
          },
        ],
      },
      {
        title: "[demo] Node.js 22 end of life",
        messages: [
          { role: "user", created_at: at(nov3, "16:40", tz), text: "When does Node.js 22 reach end of life, and should we move our services to Node 24?" },
          {
            role: "assistant",
            created_at: at(nov3, "16:41", tz),
            text: `Node.js 22 is in Maintenance LTS and reaches end of life on 30 April 2027 [S1]. Node.js 24 entered Active LTS in October 2025 and is supported until April 2028 [S1].

Recommendation: yes, plan the move to Node 24 now; you keep a year of overlap before 22 stops getting security fixes.

As of ${nov3}.`,
            sources: [
              { url: "https://nodejs.org/en/about/previous-releases", title: "[demo snapshot] Node.js releases", published_at: null, excerpt: "v24 Active LTS, end of life April 2028. v22 Maintenance LTS, end of life 2027-04-30." },
            ],
          },
        ],
      },
      {
        title: "[demo] Postgres hosting prices",
        messages: [
          { role: "user", created_at: at(tuesday, "11:05", tz), text: "Compare Postgres hosting for a small production app: Neon, Supabase and AWS RDS. What does each cost to start?" },
          {
            role: "assistant",
            created_at: at(tuesday, "11:06", tz),
            text: `For a small production app:

- **Neon** Launch: usage-based, from $5/month minimum [S1]
- **Supabase** Pro: $25/month per project, includes $10 of compute credits [S2]
- **AWS RDS for PostgreSQL**: db.t4g.micro about $0.016/hour (~$12/month) plus $0.115/GB-month storage in us-east-1 [S3]

Cheapest to start is Neon; Supabase bundles auth and storage; RDS gives the most control.

As of ${tuesday}.`,
            sources: [
              { url: "https://neon.com/pricing", title: "[demo snapshot] Neon pricing", published_at: null, excerpt: "Launch: usage-based, $5 minimum monthly spend. Compute $0.14/CU-hour, storage $0.35/GB-month." },
              { url: "https://supabase.com/pricing", title: "[demo snapshot] Supabase pricing", published_at: null, excerpt: "Pro: From $25/month. Includes $10 in compute credits. 8 GB disk per project." },
              { url: "https://aws.amazon.com/rds/postgresql/pricing/", title: "[demo snapshot] Amazon RDS for PostgreSQL pricing", published_at: null, excerpt: "db.t4g.micro On-Demand $0.016 per hour (US East). General Purpose SSD (gp2) storage $0.115 per GB-month." },
            ],
          },
          { role: "user", created_at: at(tuesday, "11:12", tz), text: "We'll go with Neon for now." },
          {
            role: "assistant",
            created_at: at(tuesday, "11:12", tz),
            text: "Noted: Neon for now. Set a spend limit on the Launch plan so usage-based compute can't surprise you.",
          },
        ],
      },
    ],
  };
}

/** Remove previous demo conversations, then import fresh ones dated relative to now(). */
export function seedDemo(tz: string): { conversations: number; messages: number } {
  const conn = db();
  const ids = (conn.prepare("SELECT id FROM conversations WHERE title LIKE '[demo]%'").all() as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) deleteConversation(id);
  return importConversations(demoPayload(tz));
}
