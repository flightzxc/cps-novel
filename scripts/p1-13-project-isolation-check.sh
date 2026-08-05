#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="${P1_13_PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cps_root="${P1_13_CPS_ROOT:-/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux}"
cps_expected_head="${P1_13_CPS_EXPECTED_HEAD:-d77c3b968285698529cf97c7f0f97b286d7a2a9c}"
failures=0

fail() {
  local category="$1"
  local path="$2"
  local detail="${3:-}"
  failures=$((failures + 1))
  printf 'P1_13_ISOLATION_FAILURE category=%s path=%s' "$category" "$path" >&2
  if [[ -n "$detail" ]]; then printf ' detail=%s' "$detail" >&2; fi
  printf '\n' >&2
}

if ! git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail PROJECT_REPOSITORY "$project_root" "not-a-git-worktree"
else
  while IFS= read -r -d '' entry; do
    metadata="${entry%%$'\t'*}"
    tracked_path="${entry#*$'\t'}"
    mode="${metadata%% *}"
    case "$mode" in
      120000) fail GIT_SYMLINK "$tracked_path" ;;
      160000) fail GIT_SUBMODULE "$tracked_path" ;;
    esac
  done < <(git -C "$project_root" ls-files -s -z)

  if [[ -e "$project_root/.gitmodules" ]] \
    || git -C "$project_root" ls-files --error-unmatch .gitmodules >/dev/null 2>&1; then
    fail GITMODULES ".gitmodules"
  fi

  cps_basename="$(basename "$cps_root")"
  while IFS= read -r -d '' tracked_path; do
    case "$tracked_path" in
      package.json|package-lock.json|tsconfig*|next.config.*|vitest.config.*|Dockerfile|Dockerfile.*|docker-compose.yml|docker-compose.yaml|compose.yml|compose.yaml|compose.*.yml|compose.*.yaml|src/*|worker/*|scheduler/*|scripts/*)
        ;;
      *) continue ;;
    esac
    case "$tracked_path" in
      *.md|*.markdown|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2) continue ;;
      scripts/p1-13-project-isolation-check.sh) continue ;;
    esac
    absolute_path="$project_root/$tracked_path"
    [[ -f "$absolute_path" ]] || continue
    if grep -Fn -- "$cps_root" "$absolute_path" >/dev/null 2>&1; then
      fail CPS_ABSOLUTE_REFERENCE "$tracked_path"
    fi
    if grep -Fn -- "$cps_basename" "$absolute_path" >/dev/null 2>&1; then
      fail CPS_REPOSITORY_REFERENCE "$tracked_path"
    fi
    if grep -En -- "(file:|workspace:)[^[:space:]\"']*(cps项目|cps-admin)" "$absolute_path" >/dev/null 2>&1; then
      fail CPS_LOCAL_DEPENDENCY "$tracked_path"
    fi
    if grep -En -- "(from|require\\(|import\\()[[:space:]]*[\"'][^\"']*(cps项目|cps-admin)" "$absolute_path" >/dev/null 2>&1; then
      fail CPS_RUNTIME_IMPORT "$tracked_path"
    fi
    if [[ "$tracked_path" == Dockerfile* || "$tracked_path" == *compose*.yml || "$tracked_path" == *compose*.yaml ]]; then
      if grep -En -- '(COPY|ADD|volume|volumes:)[^#]*(cps项目|cps-admin)' "$absolute_path" >/dev/null 2>&1; then
        fail CPS_DOCKER_REFERENCE "$tracked_path"
      fi
    fi
  done < <(git -C "$project_root" ls-files -z)
fi

if ! git -C "$cps_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail CPS_REPOSITORY "$cps_root" "not-a-git-worktree"
else
  actual_head="$(git -C "$cps_root" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$actual_head" != "$cps_expected_head" ]]; then
    fail CPS_HEAD "$cps_root" "expected=${cps_expected_head},actual=${actual_head:-missing}"
  fi
  if [[ -n "$(git -C "$cps_root" status --porcelain)" ]]; then
    fail CPS_STATUS "$cps_root" "worktree-not-clean"
  fi
fi

if (( failures > 0 )); then
  printf 'P1_13_PROJECT_ISOLATION=FAIL failures=%d\n' "$failures" >&2
  exit 1
fi

printf 'P1_13_PROJECT_ISOLATION=PASS\n'
printf 'SYMLINKS=NONE\n'
printf 'SUBMODULES=NONE\n'
printf 'CPS_RUNTIME_REFERENCES=NONE\n'
printf 'CPS_HEAD=%s\n' "$cps_expected_head"
printf 'CPS_STATUS=CLEAN\n'
