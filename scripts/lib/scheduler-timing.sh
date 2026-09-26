#!/usr/bin/env bash

# Pure calculation: skip elapsed boundaries, then allow two seconds for clock
# granularity. Inputs are integer epoch seconds and the validated interval.
scheduler_sleep_seconds() {
  local finished_at="$1" interval="$2"
  echo "$(( (finished_at / interval + 1) * interval + 2 - finished_at ))"
}
