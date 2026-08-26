#!/usr/bin/env bash
set -euo pipefail
set +x

X8_LIMIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
X8_LIMIT_NETWORK="cps-novel-x8-limiter-smoke-$$"
X8_LIMIT_SLOW="x8-slow-upstream"
X8_LIMIT_NGINX="x8-limiter-nginx-$$"
X8_LIMIT_PORT="${X8_LIMITER_SMOKE_PORT:-18080}"
X8_LIMIT_NGINX_IMAGE="${X8_NGINX_IMAGE:-nginx:1.28.0-alpine}"

cleanup() {
  docker rm -f "$X8_LIMIT_NGINX" "$X8_LIMIT_SLOW" >/dev/null 2>&1 || true
  docker network rm "$X8_LIMIT_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$X8_LIMIT_PORT" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo "ERROR: limiter smoke port $X8_LIMIT_PORT is already in use" >&2
  exit 69
fi

docker network create "$X8_LIMIT_NETWORK" >/dev/null
docker run -d --rm --name "$X8_LIMIT_SLOW" --network "$X8_LIMIT_NETWORK" node:20-alpine \
  node -e 'require("node:http").createServer((_request,response)=>setTimeout(()=>response.end("ok"),2000)).listen(3000,"0.0.0.0")' \
  >/dev/null
docker run -d --rm --name "$X8_LIMIT_NGINX" --network "$X8_LIMIT_NETWORK" \
  -p "127.0.0.1:${X8_LIMIT_PORT}:8080" \
  -v "$X8_LIMIT_ROOT/infra/production-like/nginx:/etc/nginx/x8-source:ro" \
  -v "$X8_LIMIT_ROOT/infra/production-like/nginx/limiters-smoke.conf:/etc/nginx/nginx.conf:ro" \
  "$X8_LIMIT_NGINX_IMAGE" >/dev/null

ready=no
for _ in $(seq 1 30); do
  if curl --silent --output /dev/null "http://127.0.0.1:${X8_LIMIT_PORT}/novel/ready"; then
    ready=yes
    break
  fi
  sleep 1
done
[[ "$ready" == "yes" ]] || { echo "ERROR: limiter smoke nginx did not become ready" >&2; exit 1; }

assert_connection_limit() {
  local path="$1" allowed="$2" expected="$3"
  local pids=() status
  for _ in $(seq 1 "$allowed"); do
    curl --silent --output /dev/null "http://127.0.0.1:${X8_LIMIT_PORT}${path}" &
    pids+=("$!")
  done
  sleep 0.3
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${X8_LIMIT_PORT}${path}")"
  [[ "$status" == "$expected" ]] || {
    echo "ERROR: connection limiter for $path returned $status, expected $expected" >&2
    exit 1
  }
  local pid
  for pid in "${pids[@]}"; do wait "$pid" || true; done
}

assert_rate_limit() {
  local path="$1" accepted="$2" user_agent="$3"
  local pids=() status
  for _ in $(seq 1 "$accepted"); do
    curl --silent --output /dev/null --user-agent "$user_agent" \
      "http://127.0.0.1:${X8_LIMIT_PORT}${path}" &
    pids+=("$!")
  done
  sleep 0.2
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --user-agent "$user_agent" \
    "http://127.0.0.1:${X8_LIMIT_PORT}${path}")"
  [[ "$status" == "429" ]] || {
    echo "ERROR: rate limiter for $path returned $status, expected 429" >&2
    exit 1
  }
  local pid
  for pid in "${pids[@]}"; do wait "$pid" || true; done
}

assert_connection_limit /novel/connection-smoke 8 429
assert_connection_limit /go/connection-smoke 16 429
assert_connection_limit /browse 6 429
assert_rate_limit /novel/ai-smoke 3 ClaudeBot
assert_rate_limit /go/ai-smoke 2 GPTBot
assert_rate_limit '/browse?page=4' 3 Mozilla/5.0

echo "X8_LIMITERS_SMOKE=PASS"
