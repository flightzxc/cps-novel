#!/usr/bin/env bash
# 施工工单_D9_up数据库准备原子化与镜像保留_2026-09-09.md, D-9b §4.6 test
# fixture -- a stub `docker` CLI for tests/backend/runtime/x8-image-retention.test.ts.
# Models exactly the six invocation shapes x8_gc() (scripts/x8-production-like.sh)
# issues, and nothing else:
#   docker images --filter="reference=cps-novel:0.1.0-*" --format '...'   (candidates)
#   docker images --filter="dangling=true" --format '{{.ID}}'            (dangling)
#   docker ps -a --format '{{.Image}}'                                   (in-use)
#   docker image inspect <tag> --format '{{.Size}}'                      (size accounting)
#   docker rmi <tag>                                                     (deletion)
#   docker image prune -f                                                (dangling cleanup)
# Every invocation is appended, verbatim, to $STUB_GC_LOG when set, so a
# test can assert both what WAS called (e.g. `rmi` argv) and -- just as
# important for this work order -- what NEVER was (no `-f` on `rmi`, no
# `-a`/`-af` anywhere, ever). Never talks to a real daemon.
#
# Deliberately does NOT implement real `--filter` semantics: it returns
# $STUB_GC_IMAGES for ANY `docker images` call whose args do not literally
# contain "dangling=true", regardless of what the reference filter actually
# says. This is intentional, not laziness -- it is what lets a test prove
# x8_gc() applies its OWN bash-side `cps-novel:0.1.0-*` shape check on
# whatever docker hands back, rather than trusting the `--filter` flag alone
# to keep cps-admin-*/postgres/nginx entries out of the candidate set.
set -euo pipefail

if [[ -n "${STUB_GC_LOG:-}" ]]; then
  { printf 'ARGS:'; printf ' %s' "$@"; printf '\n'; } >>"$STUB_GC_LOG"
fi

if [[ "${1:-}" == "images" ]]; then
  shift
  is_dangling=0
  for arg in "$@"; do
    case "$arg" in
      *dangling=true*) is_dangling=1 ;;
    esac
  done
  if [[ "$is_dangling" == "1" ]]; then
    if [[ -n "${STUB_GC_DANGLING:-}" ]]; then
      printf '%s\n' "${STUB_GC_DANGLING}"
    fi
  else
    if [[ -n "${STUB_GC_IMAGES:-}" ]]; then
      printf '%s\n' "${STUB_GC_IMAGES}"
    fi
  fi
  exit 0
fi

if [[ "${1:-}" == "ps" ]]; then
  # docker ps -a --format '{{.Image}}'
  if [[ -n "${STUB_GC_PS_IMAGES:-}" ]]; then
    printf '%s\n' "${STUB_GC_PS_IMAGES}"
  fi
  exit 0
fi

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  ref="${3:-}"
  size="$(printf '%s\n' "${STUB_GC_IMAGE_SIZES:-}" | awk -F= -v r="$ref" '$1==r {print $2; found=1} END {if (!found) print ""}')"
  echo "${size:-0}"
  exit 0
fi

if [[ "${1:-}" == "rmi" ]]; then
  tag="${2:-}"
  old_ifs="$IFS"
  IFS=','
  for failing in ${STUB_GC_RMI_FAIL:-}; do
    if [[ "$tag" == "$failing" ]]; then
      IFS="$old_ifs"
      echo "Error: unable to delete $tag (must be forced) - image is referenced in multiple repositories" >&2
      exit 1
    fi
  done
  IFS="$old_ifs"
  exit 0
fi

if [[ "${1:-}" == "image" && "${2:-}" == "prune" ]]; then
  if [[ -n "${STUB_GC_PRUNE_LOG:-}" ]]; then
    echo "PRUNED" >>"$STUB_GC_PRUNE_LOG"
  fi
  exit 0
fi

echo "Error: unsupported docker invocation in x8-gc-stub-docker.sh: $*" >&2
exit 1
