"""
Mini Chat load test: many users, each with their own backdated history, asking the deliverable
memory questions concurrently through the load balancer. Every response is checked:

  - the turn streams to "done",
  - recall resolved the date correctly and returned this user's own past turn (by a secret token
    planted in each user's history), and
  - no recalled record belongs to another user (no foreign token ever appears).

The clock is frozen at Wednesday 11 Nov 2026 (Asia/Kolkata), so "on Monday" is 9 Nov and
"last Tuesday" is 10 Nov. Correctness failures are reported as Locust failures and summarised in
results/correctness.json. The LLM and web search are mocked (see mock-llm.ts), so this measures the
app, recall, Postgres, Redis and the worker, not the provider.
"""
import json
import re
import secrets
import threading
from collections import Counter

from locust import HttpUser, between, events, task

TZ = "Asia/Kolkata"
TOKEN_RE = re.compile(r"tok-[a-z0-9]{10}")

lock = threading.Lock()
tally = Counter()          # check name -> failures
counts = Counter()         # scenario -> turns
upstreams = Counter()      # app replica -> requests
foreign_leaks = []         # any evidence of cross-user data


def history(token):
    """Three backdated conversations, each question carrying this user's token."""
    def turn(day, hhmm, q, a):
        return [
            {"role": "user", "text": q, "created_at": f"{day}T{hhmm}:00+05:30"},
            {"role": "assistant", "text": a, "created_at": f"{day}T{hhmm}:30+05:30"},
        ]
    return {
        "tz": TZ,
        "conversations": [
            {"title": f"CRM shortlist {token}", "messages": turn("2026-11-09", "10:12",
                f"[{token}] We're a 20-person sales team. Shortlist 5 CRM tools with per-seat pricing.",
                f"[{token}] Shortlist: HubSpot $90/seat, Salesforce $100/user, Pipedrive $49/seat, Zoho $23/user, Freshsales $39/user.")},
            {"title": f"Postgres hosting {token}", "messages": turn("2026-11-10", "11:05",
                f"[{token}] Compare Postgres hosting for a small production app: Neon, Supabase and AWS RDS.",
                f"[{token}] Neon from $5/month, Supabase Pro $25/month, RDS db.t4g.micro about $12/month.")},
            {"title": f"Node.js EOL {token}", "messages": turn("2026-11-03", "16:40",
                f"[{token}] When does Node.js 22 reach end of life, and should we move to Node 24?",
                f"[{token}] Node.js 22 reaches end of life on 30 April 2027; plan the move to 24.")},
        ],
    }


# (scenario, question, expected local date of the recalled turn or None for "no record", topic word)
SCENARIOS = [
    ("crm-monday", "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?", "2026-11-09", "CRM"),
    ("postgres-last-tuesday", "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "2026-11-10", "Postgres"),
    ("nov-3", "What did I ask you on 3 November? Is your answer still correct today?", "2026-11-03", "Node.js"),
    ("no-record", "What did I ask you on 20 October?", None, None),
]


def parse_sse(text):
    events_ = []
    for block in text.split("\n\n"):
        data = next((l[6:] for l in block.split("\n") if l.startswith("data: ")), None)
        if data:
            events_.append(json.loads(data))
    return events_


class ChatUser(HttpUser):
    wait_time = between(1, 3)

    def on_start(self):
        self.token = "tok-" + secrets.token_hex(5)
        self.username = "lt-" + secrets.token_hex(6)
        r = self.client.post("/api/auth/dev-login", json={"username": self.username}, name="/api/auth/dev-login")
        self.auth = {"authorization": f"Bearer {r.json()['token']}"}
        self.client.post("/api/import", json=history(self.token), headers=self.auth, name="/api/import")

    def fail(self, resp, check, detail):
        with lock:
            tally[check] += 1
        resp.failure(f"{check}: {detail}")

    def ask(self, scenario, question, expected_date, topic):
        with self.client.post("/api/chat", json={"text": question, "tz": TZ}, headers=self.auth,
                              name=f"/api/chat [{scenario}]", catch_response=True, timeout=120) as resp:
            with lock:
                counts[scenario] += 1
                upstreams[resp.headers.get("X-Upstream", "?")] += 1
            if resp.status_code != 200:
                return self.fail(resp, "http", resp.status_code)
            evs = parse_sse(resp.text)
            types = [e["type"] for e in evs]
            if "done" not in types:
                err = next((e.get("message") for e in evs if e["type"] == "error"), "no done event")
                return self.fail(resp, "turn completed", err)
            memory = next((e for e in evs if e["type"] == "memory"), None)
            if memory is None:
                return self.fail(resp, "memory event", "missing")
            recalled = memory.get("recalled", [])
            # Isolation: every token seen anywhere in the recall or the answer must be this user's own.
            answer = "".join(e.get("delta", "") for e in evs if e["type"] == "text")
            seen = set(TOKEN_RE.findall(json.dumps(recalled) + answer))
            foreign = seen - {self.token}
            if foreign:
                with lock:
                    foreign_leaks.append({"user": self.username, "scenario": scenario, "foreign": sorted(foreign)})
                return self.fail(resp, "isolation", f"saw other users' tokens {sorted(foreign)}")
            if expected_date is None:
                if memory.get("status") != "none" or recalled:
                    return self.fail(resp, "no record -> none", f"status {memory.get('status')}, {len(recalled)} recalled")
                return resp.success()
            mine = [r for r in recalled if self.token in r.get("question", "")]
            if not mine:
                return self.fail(resp, "recalled own turn", f"status {memory.get('status')}, recalled {[r.get('local_date') for r in recalled]}")
            if not any(r["local_date"] == expected_date and topic.lower() in r["question"].lower() for r in mine):
                return self.fail(resp, "right date + topic", f"expected {expected_date} {topic}, got {[(r['local_date'], r['question'][:50]) for r in mine]}")
            resp.success()

    @task(3)
    def crm_monday(self):
        self.ask(*SCENARIOS[0])

    @task(3)
    def postgres_last_tuesday(self):
        self.ask(*SCENARIOS[1])

    @task(2)
    def nov_3(self):
        self.ask(*SCENARIOS[2])

    @task(1)
    def no_record(self):
        self.ask(*SCENARIOS[3])

    @task(1)
    def list_is_private(self):
        with self.client.get("/api/conversations", headers=self.auth, name="/api/conversations", catch_response=True) as resp:
            titles = [c.get("title") or "" for c in resp.json().get("conversations", [])]
            foreign = {t for title in titles for t in TOKEN_RE.findall(title)} - {self.token}
            if foreign:
                with lock:
                    foreign_leaks.append({"user": self.username, "scenario": "list", "foreign": sorted(foreign)})
                return self.fail(resp, "isolation", f"listed other users' conversations {sorted(foreign)}")
            if not any(self.token in t for t in titles):
                return self.fail(resp, "own history listed", "own imported conversations missing")
            resp.success()


@events.test_stop.add_listener
def summary(environment, **_):
    stats = environment.stats
    out = {
        "users": environment.runner.user_count if environment.runner else None,
        "turns_by_scenario": dict(counts),
        "correctness_failures": dict(tally),
        "cross_user_leaks": foreign_leaks[:20],
        "requests_by_app_replica": dict(upstreams),
        "latency_ms": {
            name: {
                "requests": e.num_requests,
                "failures": e.num_failures,
                "p50": e.get_response_time_percentile(0.5),
                "p95": e.get_response_time_percentile(0.95),
                "p99": e.get_response_time_percentile(0.99),
                "max": round(e.max_response_time or 0),
            }
            for (name, _method), e in stats.entries.items()
        },
        "total": {"requests": stats.total.num_requests, "failures": stats.total.num_failures, "rps": round(stats.total.total_rps, 2)},
    }
    with open("results/correctness.json", "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))
