#!/usr/bin/env bash
# Run the load test end to end: stack with mock LLM/search + 3 app replicas + 2 workers, Locust, then
# report how long the extraction backlog takes to drain. Results land in loadtest/results/.
#   LT_USERS=200 LT_SPAWN_RATE=20 LT_DURATION=3m bash loadtest/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_FILE=docker-compose.yml:loadtest/docker-compose.loadtest.yml
docker compose up -d --build --wait app lb worker mock-llm
docker compose run --rm --no-deps locust || true

pending() { docker compose exec -T postgres psql -U postgres -d memochat -tAc "SELECT count(*) FROM jobs WHERE status IN ('pending','running')"; }
start=$(date +%s); left=$(pending)
echo "[loadtest] extraction backlog right after the run: $left job(s)"
while [ "$left" -gt 0 ] && [ $(( $(date +%s) - start )) -lt 600 ]; do sleep 5; left=$(pending); done
echo "[loadtest] backlog drained to $left in $(( $(date +%s) - start ))s"
echo "[loadtest] summary: loadtest/results/correctness.json, report: loadtest/results/report.html"
