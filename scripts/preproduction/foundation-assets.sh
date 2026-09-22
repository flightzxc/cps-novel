#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env
shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
state_file="$shared/foundation-assets-state.json"

# ---------------------------------------------------------------------------
# Foundation-assets orchestrator.
#
# Preproduction target machines start with all foundation-asset tables at
# zero rows. Four already-shipped, operator-run CLIs (all default dry-run,
# all self-audit via OperationAudit, all outside the `mutateAdmin*` semantic
# layer, so none of them needs an admin session/2FA) seed them, in this
# dependency order:
#   1. scripts/register-moboreader-foundation.ts          -- Channel changdu /
#      SourceApp moboreader / ChannelApp / 4 ChannelCapability rows.
#   2. scripts/p2-06-5-production/tagging-bootstrap.ts     -- 123 CanonicalTag +
#      360 canonical_tag_keyword + 196 source_label_mapping + 123 zh
#      translations. Needs the ChannelApp's own id from stage 1
#      (`--channel-app changdu-app=<uuid>`).
#   3. scripts/p2-06-5-production/canonical-tag-translation-overlay.ts --
#      1845 additional (non-zh) canonical_tag_translation rows. Must run
#      after 2 -- it only upserts translations for CanonicalTag rows that
#      already exist.
#   4. scripts/l10n/article-template-bootstrap.ts          -- 15 ArticleTemplate
#      rows, one per SITE_LOCALES member. No dependency on 1-3.
#
# This file is ONLY an orchestrator over those four CLIs -- it never
# reimplements their write logic, never creates a ChannelAccount or
# credential, never flips a capability to enabled, never opens a
# feature/write gate, and never touches SiteSetting or admin/2FA. Every
# actual database write happens inside one of the four CLIs above, each in
# its own already-reviewed transaction.
#
# 🔴 Stages 2 and 3 read hash-pinned artifacts under `docs/p2/**`. `docs/` is
# NOT copied into the application image (the Dockerfile's runner stage only
# COPYs standalone/static/node_modules/prisma/src/worker/scheduler/scripts/
# infra/tsconfig) -- so this script bind-mounts the RELEASE CHECKOUT'S OWN
# `docs/` directory (this file's `$root/docs`, not the image's) read-only
# into the one-off container for those two stages only. This is safe, not a
# supply-chain shortcut: both CLIs independently hash-verify every artifact
# they read with `createHash("sha256")` and fail closed with a
# "SHA-256 mismatch" error if the mounted content is not the pinned version
# -- mounting the wrong directory is rejected on the spot, not silently
# accepted. The Dockerfile itself is intentionally left untouched: docs/ is
# 27.8MB total and the artifacts these two CLIs actually need are 0.97MB of
# it, not worth baking into every image build.
#
# Constants below (row counts, lexicon version) are this script's single
# source of truth for "what does fully-seeded look like" -- referenced from
# every subcommand rather than re-hardcoded.
# ---------------------------------------------------------------------------

FOUNDATION_STAGES=(moboreader tagging translation-overlay article-template)
readonly FOUNDATION_LEXICON_VERSION="canonical-tag-v1-keyword-seeds-v1"

foundation_asset_expected() {
  case "$1" in
    channel) echo 1 ;;
    source_app) echo 1 ;;
    channel_app) echo 1 ;;
    channel_capability) echo 4 ;;
    canonical_tag) echo 123 ;;
    canonical_tag_keyword) echo 360 ;;
    canonical_tag_translation) echo 1968 ;;
    source_label_mapping) echo 196 ;;
    article_template) echo 15 ;;
    *) echo "foundation_asset_expected: unknown asset $1" >&2; return 64 ;;
  esac
}

foundation_stage_script() {
  case "$1" in
    moboreader) echo "scripts/register-moboreader-foundation.ts" ;;
    tagging) echo "scripts/p2-06-5-production/tagging-bootstrap.ts" ;;
    translation-overlay) echo "scripts/p2-06-5-production/canonical-tag-translation-overlay.ts" ;;
    article-template) echo "scripts/l10n/article-template-bootstrap.ts" ;;
    *) echo "foundation_stage_script: unknown stage $1" >&2; return 64 ;;
  esac
}

# Stable, replayable request-id per stage -- the CLIs use it for their own
# idempotent-replay bookkeeping (an apply re-run with the same request-id
# and the same operator/reason either no-ops or refuses on a genuine
# mismatch, it never double-writes). `article-template` takes no
# --request-id at all (its usage line has none -- see this file's header);
# its own idempotency is row-level (`(templateKey, version)` upsert).
foundation_stage_request_id() {
  case "$1" in
    moboreader) echo "foundation-assets-2026-09-22-moboreader" ;;
    tagging) echo "foundation-assets-2026-09-22-tagging" ;;
    translation-overlay) echo "foundation-assets-2026-09-22-translation-overlay" ;;
    article-template) echo "" ;;
    *) echo "foundation_stage_request_id: unknown stage $1" >&2; return 64 ;;
  esac
}

foundation_stage_reason() {
  case "$1" in
    moboreader) echo "预生产基础资产编排：注册 changdu 渠道与 moboreader 剧场档案" ;;
    tagging) echo "预生产基础资产编排：引导 CanonicalTag v1 标签体系（123 标签/360 关键词/196 来源映射）" ;;
    translation-overlay) echo "预生产基础资产编排：叠加 CanonicalTag 公开语种译名" ;;
    article-template) echo "" ;;
    *) echo "foundation_stage_reason: unknown stage $1" >&2; return 64 ;;
  esac
}

usage() {
  echo "usage: foundation-assets.sh status|plan|apply" >&2
  exit 64
}

# ---------------------------------------------------------------------------
# One-off container invocation.
# ---------------------------------------------------------------------------

# Populates the global array FOUNDATION_MOUNT_ARGS with the docs bind-mount
# args for stages that need it (see this file's header comment), empty for
# the other two.
foundation_stage_mount_args() {
  FOUNDATION_MOUNT_ARGS=()
  case "$1" in
    tagging|translation-overlay) FOUNDATION_MOUNT_ARGS=(-v "$root/docs:/app/docs:ro") ;;
  esac
}

# Runs one stage's CLI. $1 = stage, $2 = mode ("dry-run" | "apply").
# Captures stdout/stderr to $FOUNDATION_STAGE_STDOUT_FILE /
# $FOUNDATION_STAGE_STDERR_FILE (the caller creates these under its own
# mktemp -d and is responsible for reading them before the next call
# overwrites them). Returns the CLI's own exit code.
#
# 🔴 Every flag emitted below was verified against that CLI's own argument
# parser (`parseCliOptions` / `parseTaggingBootstrapCliOptions` /
# `parseTranslationOverlayCliOptions` / article-template-bootstrap.ts's
# parser) -- never a flag advertised only by a sibling CLI.
run_stage() {
  local stage="$1" mode="$2"
  local script request_id reason
  script="$(foundation_stage_script "$stage")"
  request_id="$(foundation_stage_request_id "$stage")"
  reason="$(foundation_stage_reason "$stage")"

  foundation_stage_mount_args "$stage"
  local env_args=(-e DATABASE_URL="$P1_12_WEB_DATABASE_URL")
  local cli_args=()

  case "$stage" in
    moboreader)
      env_args+=(-e MOBOREADER_FOUNDATION_OPERATOR="$PREPROD_FOUNDATION_OPERATOR")
      cli_args=(--request-id "$request_id" --reason "$reason")
      [[ "$mode" == "apply" ]] && cli_args+=(--apply)
      ;;
    tagging)
      [[ -n "${FOUNDATION_CHANNEL_APP_ID:-}" ]] || {
        echo "FOUNDATION_STAGE_RUN=REFUSED stage=$stage reason=channel_app_not_ready" >&2
        return 65
      }
      cli_args=(--request-id "$request_id" --reason "$reason" --channel-app "changdu-app=$FOUNDATION_CHANNEL_APP_ID")
      [[ "$mode" == "apply" ]] && cli_args+=(--approver "$PREPROD_FOUNDATION_APPROVER" --apply)
      ;;
    translation-overlay)
      cli_args=(--request-id "$request_id" --reason "$reason")
      [[ "$mode" == "apply" ]] && cli_args+=(--approver "$PREPROD_FOUNDATION_APPROVER" --apply)
      ;;
    article-template)
      cli_args=()
      [[ "$mode" == "apply" ]] && cli_args+=(--approver "$PREPROD_FOUNDATION_APPROVER" --apply)
      ;;
    *)
      echo "run_stage: unknown stage $stage" >&2
      return 64
      ;;
  esac

  # 🔴 应用镜像入口一律走 preprod_compose_app_run(不可变闸门);每个调用都带
  # </dev/null -- 目标机上这类调用常经 `ssh 'bash -s' <<EOF` 形态执行,不加会
  # 把 heredoc 剩余内容当 stdin 吃掉(这个仓库已经踩过两次)。
  preprod_compose_app_run \
    "${env_args[@]}" \
    ${FOUNDATION_MOUNT_ARGS[@]+"${FOUNDATION_MOUNT_ARGS[@]}"} \
    web tsx "$script" ${cli_args[@]+"${cli_args[@]}"} \
    </dev/null >"$FOUNDATION_STAGE_STDOUT_FILE" 2>"$FOUNDATION_STAGE_STDERR_FILE"
}

# A dry-run's stderr containing this exact substring means one of the two
# hash-pinned-artifact CLIs (tagging / translation-overlay) refused with its
# own `sha256_mismatch` error -- see `fail("sha256_mismatch", \`${label} SHA-256
# mismatch: ...\`)` in both scripts. Only `.message` ever reaches stderr
# (both CLIs' entrypoints do `console.error(error.message)`, never
# `error.code`), so this matches the MESSAGE text, not the error code.
foundation_is_sha_mismatch() {
  grep -q "SHA-256 mismatch" "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Read-only runtime facts: the changdu ChannelApp's id (needed to build
# stage 2/3's --channel-app binding) and whether it already has an active
# ChannelAccount / active credential (needed for `status`'s NO_ACCOUNT /
# NO_CREDENTIAL). Sets the globals FOUNDATION_CHANNEL_APP_ID,
# FOUNDATION_ACCOUNT_COUNT, FOUNDATION_CREDENTIAL_COUNT.
#
# Read-only, same web_app DATABASE_URL every other call here uses -- never
# creates a ChannelAccount or credential (see this file's header "不要做").
# ---------------------------------------------------------------------------
read_runtime_facts() {
  local out
  out="$(preprod_compose_app_run \
    -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
    web node -e '
      const { PrismaClient } = require("@prisma/client");
      (async () => {
        const db = new PrismaClient();
        try {
          const channelApp = await db.channelApp.findFirst({
            where: { externalAppId: "moboreader", channel: { code: "changdu" }, sourceApp: { code: "moboreader" } },
            select: { id: true, channelId: true },
          });
          if (!channelApp) {
            console.log("channel_app_id=");
            console.log("accounts=0");
            console.log("credentials=0");
            return;
          }
          const accounts = await db.channelAccount.count({
            where: { channelId: channelApp.channelId, status: "active", deletedAt: null },
          });
          const credentials = await db.channelAccountCredential.count({
            where: { status: "active", channelAccount: { channelId: channelApp.channelId, status: "active", deletedAt: null } },
          });
          console.log("channel_app_id=" + channelApp.id);
          console.log("accounts=" + accounts);
          console.log("credentials=" + credentials);
        } finally {
          await db.$disconnect();
        }
      })().catch((error) => { console.error(String((error && error.message) || error)); process.exitCode = 1; });
    ' </dev/null)" || {
    echo "FOUNDATION_RUNTIME_FACTS=REFUSED reason=read_failed" >&2
    return 65
  }

  FOUNDATION_CHANNEL_APP_ID="$(printf '%s\n' "$out" | sed -n 's/^channel_app_id=//p')"
  FOUNDATION_ACCOUNT_COUNT="$(printf '%s\n' "$out" | sed -n 's/^accounts=//p')"
  FOUNDATION_CREDENTIAL_COUNT="$(printf '%s\n' "$out" | sed -n 's/^credentials=//p')"
}

# ---------------------------------------------------------------------------
# Report parsers: each dry-run CLI already computes and prints (as JSON) the
# exact counts `status`/`plan` need -- these just pull them out, never
# re-derive them independently. A banner line
# ("[DRY RUN ...]") may precede the JSON, so every parser looks for the
# first "{" rather than assuming the JSON starts at column 0.
# ---------------------------------------------------------------------------

foundation_parse_moboreader() {
  node -e '
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    if (start === -1) process.exit(3);
    const r = JSON.parse(raw.slice(start));
    const missing = Array.isArray(r.missing) ? r.missing : [];
    const hasPrefix = (p) => missing.some((m) => typeof m === "string" && m.startsWith(p));
    const caps = r.capabilityStatuses || {};
    const capCount = Object.values(caps).filter((v) => v !== null).length;
    console.log("channel=" + (hasPrefix("channel:") ? 0 : 1));
    console.log("source_app=" + (hasPrefix("source_app:") ? 0 : 1));
    console.log("channel_app=" + (hasPrefix("channel_app:") ? 0 : 1));
    console.log("channel_capability=" + capCount);
  ' "$1"
}

foundation_parse_tagging() {
  node -e '
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    if (start === -1) process.exit(3);
    const r = JSON.parse(raw.slice(start));
    const before = r.databaseBefore || {};
    console.log("canonical_tag=" + (before.canonicalTag || 0));
    console.log("canonical_tag_keyword=" + (before.canonicalTagKeyword || 0));
    console.log("source_label_mapping=" + (before.sourceLabelMapping || 0));
  ' "$1"
}

foundation_parse_translation_overlay() {
  node -e '
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    if (start === -1) process.exit(3);
    const r = JSON.parse(raw.slice(start));
    console.log("canonical_tag_translation=" + (r.databaseBefore || 0));
  ' "$1"
}

foundation_parse_article_template() {
  node -e '
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    if (start === -1) process.exit(3);
    const r = JSON.parse(raw.slice(start));
    const planned = r.planned || {};
    const localeCount = (Array.isArray(r.locales) && r.locales.length) || 15;
    console.log("article_template=" + Math.max(localeCount - (planned.create || 0), 0));
  ' "$1"
}

# Applies KEY=VALUE lines (as printed by the parsers above) as shell
# variables of the caller's frame. Deliberately `printf -v`, not `eval` --
# every value here came from our own JSON parse of a report we just
# generated, but there is no reason to reach for eval when a builtin does
# the same job.
foundation_apply_kv_lines() {
  local key value
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    printf -v "$key" '%s' "$value"
  done <<<"$1"
}

# stage-scoped "would this apply write anything new" check, used by `apply`
# to decide whether to skip the real --apply call. Compares each stage's
# dry-run report against this file's own expected constants (never the
# CLI's own "planned" total, which -- for tagging/translation-overlay --
# is the full target shape regardless of what already exists).
foundation_stage_already_satisfied() {
  local stage="$1" raw="$2"
  node -e '
    const [stage, raw, tag, keyword, mapping, translation] = process.argv.slice(1);
    const start = raw.indexOf("{");
    if (start === -1) process.exit(1);
    const r = JSON.parse(raw.slice(start));
    let satisfied = false;
    if (stage === "moboreader") {
      satisfied = Array.isArray(r.missing) && r.missing.length === 0;
    } else if (stage === "tagging") {
      const b = r.databaseBefore || {};
      satisfied = (b.canonicalTag || 0) >= Number(tag)
        && (b.canonicalTagKeyword || 0) >= Number(keyword)
        && (b.sourceLabelMapping || 0) >= Number(mapping);
    } else if (stage === "translation-overlay") {
      satisfied = (r.databaseBefore || 0) >= Number(translation);
    } else if (stage === "article-template") {
      satisfied = ((r.planned || {}).create || 0) === 0;
    }
    process.exit(satisfied ? 0 : 1);
  ' "$stage" "$raw" \
    "$(foundation_asset_expected canonical_tag)" \
    "$(foundation_asset_expected canonical_tag_keyword)" \
    "$(foundation_asset_expected source_label_mapping)" \
    "$(foundation_asset_expected canonical_tag_translation)"
}

foundation_plan_summary() {
  case "$1" in
    moboreader) foundation_parse_moboreader "$2" | tr '\n' ' ' ;;
    tagging) foundation_parse_tagging "$2" | tr '\n' ' ' ;;
    translation-overlay) foundation_parse_translation_overlay "$2" | tr '\n' ' ' ;;
    article-template) foundation_parse_article_template "$2" | tr '\n' ' ' ;;
  esac
}

# ---------------------------------------------------------------------------
# $shared/foundation-assets-state.json -- one merged JSON doc, one entry per
# stage. Written after every stage `apply` completes (applied or
# already_satisfied), read-merge-written with the same atomic tmp+mv shape
# release.sh's write_state uses (never a bare overwrite -- a crash mid-write
# must never leave a truncated state file behind).
# ---------------------------------------------------------------------------
write_stage_state() {
  local stage="$1" state="$2"
  mkdir -p "$shared"
  local tmp_file="${state_file}.tmp.$$"
  node -e '
    const fs = require("fs");
    const [outPath, srcPath, stage, state, requestId] = process.argv.slice(1);
    let doc = { schemaVersion: 1, stages: {} };
    try { doc = JSON.parse(fs.readFileSync(srcPath, "utf8")); } catch {}
    if (!doc.stages) doc.stages = {};
    doc.schemaVersion = 1;
    doc.stages[stage] = { state, completedAt: new Date().toISOString(), requestId: requestId || null };
    doc.updatedAt = new Date().toISOString();
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  ' "$tmp_file" "$state_file" "$stage" "$state" "$(foundation_stage_request_id "$stage")"
  mv "$tmp_file" "$state_file"
}

# ---------------------------------------------------------------------------
# ANALYZE closer -- docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md §2
# ("数据库统计信息（ANALYZE）"). The four CLIs above only ever write to small,
# write-once registry tables (channel=1 row, channel_app=1,
# channel_capability=4, canonical_tag=123, source_label_mapping=196,
# article_template=15, ...) -- none of them will ever cross autovacuum's own
# analyze threshold (50 + 0.1 x reltuples), so without this closer these
# tables would carry zero column statistics from the moment this script runs
# until the environment is decommissioned. That checklist's own measured
# incident: the planner, forced to guess selectivity on a zero-stats 1-row
# `channel_app`, mis-costed a join badly enough to turn a 0.68ms query into
# 2,696ms (and into 500s once concurrent load hit web_app's 30s
# statement_timeout).
#
# Runs as `postgres` via the exact `preprod_compose exec -T postgres psql
# -U postgres -d cps_novel` channel `database.sh`'s migrate-approved /
# persistent-check already use for schema-adjacent maintenance -- NOT
# through the app one-off entrypoint / web_app's DATABASE_URL like every
# other call in this file. Two independent reasons, both about not silently
# under-covering the check: (1) ANALYZE's own permission model skips tables
# the invoking role does not own during a database-wide `ANALYZE;` rather
# than erroring, and web_app only owns none of these tables (it holds
# row-level SELECT/INSERT/UPDATE, per this round's own "不要扩权限"
# constraint, not ownership); (2) `pg_stats` only shows rows for tables the
# invoking role can read at all, so the verification query run as web_app
# would report every table outside this round's 10 granted tables as
# "missing stats" even when it is not -- a false positive, not a
# conservative one. `postgres` sees the whole schema for both.
#
# 🔴 判据只能是 `pg_stats` 有没有条目，不能用
# `pg_stat_user_tables.last_analyze IS NULL`：PG15+ 的统计计数器在共享内存
# 里，非正常关闭会被清零，已经分析过的表也会显示 NULL（该文档普查：54 张表
# 49 张 last_analyze 为 NULL，其中大多数 pg_stats 仍有内容）。
# ---------------------------------------------------------------------------

# Prints a comma-separated list of public-schema tables that have rows but
# zero pg_stats entries. Empty output means every such table has been
# analyzed at least once. Non-zero return = the check itself could not run
# (e.g. postgres unreachable) -- callers must fail closed on that, not treat
# it as "nothing missing".
foundation_missing_stats_tables() {
  preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 \
    -U postgres -d cps_novel -Atqc "
      SELECT string_agg(c.relname, ',')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND c.reltuples > 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_stats s
          WHERE s.schemaname = 'public' AND s.tablename = c.relname
        );
    " </dev/null
}

# Runs a whole-database ANALYZE. Read-mostly from the server's point of
# view: updates planner statistics only, changes no rows, takes no
# relation-blocking lock, and is safe to run online (checklist-measured: 11s
# on a 54k-row-scale database; this round's rows are near-empty, so faster).
foundation_run_analyze() {
  preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 \
    -U postgres -d cps_novel -c "ANALYZE;" </dev/null >/dev/null
}

# ---------------------------------------------------------------------------
# status -- read-only. One FOUNDATION_ASSET line per asset, always to
# stdout (these are data, not a pass/fail gate). The whole subcommand only
# fails (stderr + exit 65) when it cannot establish ground truth at all.
# ---------------------------------------------------------------------------
print_asset() {
  local name="$1" actual="$2" expected state
  expected="$(foundation_asset_expected "$name")"
  if (( actual >= expected )); then state=OK; else state=MISSING; fi
  echo "FOUNDATION_ASSET=$name state=$state actual=$actual expected=$expected"
}

print_asset_state() {
  local name="$1" state="$2" actual="$3" expected
  expected="$(foundation_asset_expected "$name")"
  echo "FOUNDATION_ASSET=$name state=$state actual=$actual expected=$expected"
}

cmd_status() {
  [[ -n "${PREPROD_FOUNDATION_OPERATOR:-}" ]] || {
    echo "FOUNDATION_STATUS=REFUSED reason=operator_required" >&2
    return 65
  }
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  FOUNDATION_STAGE_STDOUT_FILE="$tmp/stdout"
  FOUNDATION_STAGE_STDERR_FILE="$tmp/stderr"

  read_runtime_facts || return 65

  if ! run_stage moboreader dry-run; then
    echo "FOUNDATION_STATUS=REFUSED reason=moboreader_dry_run_failed detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n')" >&2
    return 65
  fi
  local channel=0 source_app=0 channel_app=0 channel_capability=0
  foundation_apply_kv_lines "$(foundation_parse_moboreader "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")")"
  print_asset channel "$channel"
  print_asset source_app "$source_app"
  print_asset channel_app "$channel_app"

  local cap_expected; cap_expected="$(foundation_asset_expected channel_capability)"
  if (( channel_capability < cap_expected )); then
    print_asset_state channel_capability MISSING "$channel_capability"
  elif [[ "${FOUNDATION_ACCOUNT_COUNT:-0}" == "0" ]]; then
    print_asset_state channel_capability NO_ACCOUNT "$channel_capability"
  elif [[ "${FOUNDATION_CREDENTIAL_COUNT:-0}" == "0" ]]; then
    print_asset_state channel_capability NO_CREDENTIAL "$channel_capability"
  elif [[ "${FEATURE_NOVEL_CATALOG_SYNC:-}" != "true" ]]; then
    print_asset_state channel_capability FEATURE_DISABLED "$channel_capability"
  else
    print_asset_state channel_capability OK "$channel_capability"
  fi

  local canonical_tag=0 canonical_tag_keyword=0 source_label_mapping=0
  if [[ -z "${FOUNDATION_CHANNEL_APP_ID:-}" ]]; then
    print_asset canonical_tag 0
    print_asset canonical_tag_keyword 0
    print_asset source_label_mapping 0
  elif run_stage tagging dry-run; then
    foundation_apply_kv_lines "$(foundation_parse_tagging "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")")"
    print_asset canonical_tag "$canonical_tag"
    print_asset canonical_tag_keyword "$canonical_tag_keyword"
    print_asset source_label_mapping "$source_label_mapping"
  elif foundation_is_sha_mismatch "$FOUNDATION_STAGE_STDERR_FILE"; then
    print_asset_state canonical_tag VERSION_MISMATCH 0
    print_asset_state canonical_tag_keyword VERSION_MISMATCH 0
    print_asset_state source_label_mapping VERSION_MISMATCH 0
  else
    print_asset canonical_tag 0
    print_asset canonical_tag_keyword 0
    print_asset source_label_mapping 0
  fi

  local canonical_tag_translation=0
  if run_stage translation-overlay dry-run; then
    foundation_apply_kv_lines "$(foundation_parse_translation_overlay "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")")"
    print_asset canonical_tag_translation "$canonical_tag_translation"
  elif foundation_is_sha_mismatch "$FOUNDATION_STAGE_STDERR_FILE"; then
    print_asset_state canonical_tag_translation VERSION_MISMATCH 0
  else
    print_asset canonical_tag_translation 0
  fi

  local article_template=0
  if run_stage article-template dry-run; then
    foundation_apply_kv_lines "$(foundation_parse_article_template "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")")"
    print_asset article_template "$article_template"
  else
    print_asset article_template 0
  fi

  # db_statistics is an ENVIRONMENT property, not a release artifact -- a
  # restored backup or a rebuilt database makes it disappear again even
  # though every row above is still there. Always computed live here, never
  # read back from foundation-assets-state.json, so a rerun after a restore
  # reports it truthfully instead of trusting a stale recorded PASS.
  local missing
  if ! missing="$(foundation_missing_stats_tables 2>"$FOUNDATION_STAGE_STDERR_FILE")"; then
    echo "FOUNDATION_STATUS=REFUSED reason=db_statistics_read_failed detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n')" >&2
    return 65
  fi
  if [[ -n "$missing" ]]; then
    echo "FOUNDATION_ASSET=db_statistics state=MISSING actual=0 expected=1 tables=$missing"
  else
    echo "FOUNDATION_ASSET=db_statistics state=OK actual=1 expected=1"
  fi
}

# ---------------------------------------------------------------------------
# plan -- dry-run every stage in dependency order, write nothing.
# ---------------------------------------------------------------------------
cmd_plan() {
  [[ -n "${PREPROD_FOUNDATION_OPERATOR:-}" ]] || {
    echo "FOUNDATION_PLAN=REFUSED reason=operator_required" >&2
    return 65
  }
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  FOUNDATION_STAGE_STDOUT_FILE="$tmp/stdout"
  FOUNDATION_STAGE_STDERR_FILE="$tmp/stderr"

  read_runtime_facts || return 65

  local stage
  for stage in "${FOUNDATION_STAGES[@]}"; do
    if [[ "$stage" == "tagging" && -z "${FOUNDATION_CHANNEL_APP_ID:-}" ]]; then
      echo "FOUNDATION_PLAN_STAGE=$stage outcome=BLOCKED_DEPENDENCY reason=channel_app_not_ready"
      continue
    fi
    if run_stage "$stage" dry-run; then
      echo "FOUNDATION_PLAN_STAGE=$stage outcome=ELIGIBLE $(foundation_plan_summary "$stage" "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")")"
      # Stage 1 landing mid-plan changes what stage 2/3 can see -- refresh so
      # a single `plan` invocation on an empty database still reports
      # tagging/translation-overlay as BLOCKED_DEPENDENCY correctly instead
      # of stale (pre-stage-1) facts.
      if [[ "$stage" == "moboreader" ]]; then read_runtime_facts || return 65; fi
    elif foundation_is_sha_mismatch "$FOUNDATION_STAGE_STDERR_FILE"; then
      echo "FOUNDATION_PLAN_STAGE=$stage outcome=VERSION_MISMATCH" >&2
      echo "FOUNDATION_PLAN=FAIL reason=version_mismatch stage=$stage" >&2
      return 65
    else
      echo "FOUNDATION_PLAN_STAGE=$stage outcome=FAIL detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n')" >&2
      echo "FOUNDATION_PLAN=FAIL reason=stage_dry_run_failed stage=$stage" >&2
      return 65
    fi
  done
  echo "FOUNDATION_PLAN=PASS"
}

# ---------------------------------------------------------------------------
# apply -- run each stage for real, in order. Every stage's own dry-run runs
# first (cheap, read-only); a stage that dry-run shows is already at its
# expected shape is skipped (already_satisfied, not re-applied). A failure
# on any stage stops the whole run immediately (fail-closed) -- state
# already written for prior stages stays, and a later re-run naturally picks
# up where this one stopped (every check here is a live dry-run re-check,
# never a "trust the state file and skip verifying" shortcut).
# ---------------------------------------------------------------------------
cmd_apply() {
  [[ -n "${PREPROD_FOUNDATION_OPERATOR:-}" ]] || {
    echo "FOUNDATION_APPLY=REFUSED reason=operator_required" >&2
    return 65
  }
  [[ -n "${PREPROD_FOUNDATION_APPROVER:-}" ]] || {
    echo "FOUNDATION_APPLY=REFUSED reason=approver_required" >&2
    return 65
  }
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  FOUNDATION_STAGE_STDOUT_FILE="$tmp/stdout"
  FOUNDATION_STAGE_STDERR_FILE="$tmp/stderr"

  local stage
  for stage in "${FOUNDATION_STAGES[@]}"; do
    read_runtime_facts || return 65

    if [[ "$stage" == "tagging" && -z "${FOUNDATION_CHANNEL_APP_ID:-}" ]]; then
      echo "FOUNDATION_APPLY_STAGE=$stage outcome=REFUSED reason=channel_app_not_ready recovery=\"rerun scripts/preproduction/foundation-assets.sh apply once the moboreader stage has landed\"" >&2
      return 65
    fi

    if ! run_stage "$stage" dry-run; then
      if foundation_is_sha_mismatch "$FOUNDATION_STAGE_STDERR_FILE"; then
        echo "FOUNDATION_APPLY_STAGE=$stage outcome=REFUSED reason=sha256_mismatch recovery=\"confirm the docs bind-mount points at THIS release checkout's own docs/ (see this script's header comment), not a stale one\"" >&2
      else
        echo "FOUNDATION_APPLY_STAGE=$stage outcome=REFUSED reason=dry_run_failed detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n')" >&2
      fi
      return 65
    fi

    if foundation_stage_already_satisfied "$stage" "$(cat "$FOUNDATION_STAGE_STDOUT_FILE")"; then
      write_stage_state "$stage" already_satisfied
      echo "FOUNDATION_APPLY_STAGE=$stage outcome=ALREADY_SATISFIED"
      continue
    fi

    if ! run_stage "$stage" apply; then
      echo "FOUNDATION_APPLY_STAGE=$stage outcome=REFUSED reason=apply_failed detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n') recovery=\"rerun scripts/preproduction/foundation-assets.sh apply -- each stage's request-id is stable, so a rerun replays/continues safely, it never double-writes\"" >&2
      return 65
    fi
    write_stage_state "$stage" applied
    echo "FOUNDATION_APPLY_STAGE=$stage outcome=PASS"
  done

  # Closer: docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md §2 -- see
  # the ANALYZE closer comment above `foundation_missing_stats_tables` for
  # why this runs as postgres rather than through the app one-off entrypoint.
  if ! foundation_run_analyze; then
    echo "FOUNDATION_APPLY_STAGE=analyze outcome=REFUSED reason=analyze_failed recovery=\"rerun: preprod_compose exec -T postgres psql -U postgres -d cps_novel -c 'ANALYZE;'\"" >&2
    return 65
  fi
  local missing
  if ! missing="$(foundation_missing_stats_tables 2>"$FOUNDATION_STAGE_STDERR_FILE")"; then
    echo "FOUNDATION_ANALYZE=FAIL reason=verification_read_failed detail=$(tail -1 "$FOUNDATION_STAGE_STDERR_FILE" | tr -d '\n')" >&2
    return 65
  fi
  if [[ -n "$missing" ]]; then
    echo "FOUNDATION_ANALYZE=FAIL tables=$missing" >&2
    return 65
  fi
  echo "FOUNDATION_ANALYZE=PASS"
  echo "FOUNDATION_APPLY=PASS"
}

case "${1:-}" in
  status) cmd_status ;;
  plan) cmd_plan ;;
  apply) cmd_apply ;;
  *) usage ;;
esac
