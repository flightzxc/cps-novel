#!/usr/bin/env bash

PREPROD_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PREPROD_ENV_FILE:=/opt/cps-novel/shared/env/preprod.env}"

# 🔴 应用镜像的**唯一真源是 release manifest**，不是 shared env。
# shared env 里若也写了 CPS_NOVEL_APP_IMAGE，会把 manifest 指定的新版本悄悄
# 覆盖回旧版本（`set -a; source env` 会覆盖已导出的同名变量），而容器照样能起来，
# 只是跑的是上一版。preprod_load_env() 因此在 source 前后比对这一个变量。
preprod_load_env() {
  [[ "$PREPROD_ENV_FILE" = /* && -r "$PREPROD_ENV_FILE" ]] || {
    echo "ERROR: PREPROD_ENV_FILE must be an absolute readable file" >&2
    return 66
  }
  local inherited_image="${CPS_NOVEL_APP_IMAGE:-}" inherited_commit="${GIT_COMMIT:-}"
  set -a
  # shellcheck disable=SC1090
  source "$PREPROD_ENV_FILE"
  set +a
  [[ "${P1_12_COMPOSE_PROJECT:-}" == "cps-novel" ]] || {
    echo "ERROR: P1_12_COMPOSE_PROJECT must equal cps-novel" >&2
    return 65
  }
  if [[ -n "$inherited_image" && "${CPS_NOVEL_APP_IMAGE:-}" != "$inherited_image" ]]; then
    echo "ERROR: env file overrides CPS_NOVEL_APP_IMAGE (manifest=$inherited_image env=${CPS_NOVEL_APP_IMAGE:-})" >&2
    return 65
  fi
  if [[ -n "$inherited_commit" && "${GIT_COMMIT:-}" != "$inherited_commit" ]]; then
    echo "ERROR: env file overrides GIT_COMMIT (manifest=$inherited_commit env=${GIT_COMMIT:-})" >&2
    return 65
  fi
  [[ -z "$inherited_image" ]] || export CPS_NOVEL_APP_IMAGE="$inherited_image"
  [[ -z "$inherited_commit" ]] || export GIT_COMMIT="$inherited_commit"
}

# --- 写闸登记制：PREPROD_APPROVED_OPEN_WRITE_GATES -------------------------
#
# 背景：预生产（bangbangji.cloud）自 2026-09-22 起不再是零业务数据环境。
# Owner 已批准并在目标机打开了目录同步写闸（2026-09-22）与推广领取写闸
# （2026-09-23）。旧版 preflight 要求这两组写闸的两个变量恒为 "false"——
# 那条规则原本是对的（预生产曾经真的零写），但 Owner 批准开闸之后，它就会在
# 每次 deploy/rollback 时把这次批准判成 FAIL，而最省事的"绕过"是把闸门关回
# false，这会静默停掉已经批准的功能。
#
# 决策（Owner 2026-09-23，见 docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md）：
# 把"两个变量必须全为 false"改成"开启前必须先在共享 env 里显式登记"。
#
# 🔴 可登记的写闸是一个封闭枚举，只有两个：
#   catalog_write → FEATURE_NOVEL_CATALOG_SYNC + NOVEL_CATALOG_SYNC_ALLOW_WRITE
#   promo_write   → FEATURE_PROMO_LINK_CLAIM + PROMO_LINK_CLAIM_ALLOW_WRITE
# 之所以是封闭枚举而不是"登记什么值都认"：登记列表本身只是共享 env 里的一行
# 文本，任何有权改目标机 env 的人都能编辑它——如果登记值本身没有约束，这道闸
# 就退化成"写你想开的名字，自动通过"，等于没有检查。封闭枚举把"新开一个写闸"
# 这件事钉在代码改动上（必须先把新名字加进下面的 case 分支，且要经 Owner 批准
# 走一遍代码审查），而不是一次 env 编辑就能绕过。其它写闸
# （indexnow_outbox / indexnow_delivery / auto_tagging / article_writes /
# tracking_write_gate / two_factor_enforcement）不在这个枚举里，原样硬关，
# 判定逻辑一行都不动。
#
# 🔴 每个可登记写闸的两个变量必须严格等于 "true" 或 "false"（大小写敏感，
# 不认 "TRUE"/"1"/空字符串/未设置）。未设置也算非法，而不是默认当 false 处理：
# 这两个变量描述的是"目标机 env 里写没写清楚这件事"，而不是"没写就当作最安全的
# 值"——本仓库吃过默认值掩盖配置缺失的亏，这里不重蹈。为保持与旧版 reason 的
# 连续性，"已登记但值非法"与"未登记但值非法"统一归为
# catalog_write_invalid / promo_write_invalid（不复用未登记时的
# catalog_write / promo_write，这样两类失败在事故排查时不会混在一起）。
#
# 🔴 dry-run 组合（FEATURE=true 但 ALLOW_WRITE=false）对已登记的写闸合法：
# 目录同步的 dry-run 模式就是这个组合——只探测/计算，不落库。已登记写闸的
# 两个变量各自 true/false 的任意组合都放行，因为"登记"批准的是"这个写闸这一轮
# 可以处于非 fail-closed 状态"，具体是全开、半开（dry-run）还是登记了但两个都
# 仍是 false，都是运维当下的选择，不需要 preflight 再替 Owner 做二次判断。
#
# 失败时把 reason 码写到 stdout（供调用方转交 fail()）并 return 65；
# 成功时打印取证行 "PREPROD_WRITE_GATES=PASS approved=... open=..." 并 return 0。
# 🔴 bash 3.2/5 双兼容：不用关联数组、${var,,}、mapfile/readarray；数组判空一律
# 用 "${arr[@]+"${arr[@]}"}" 守卫（bash 3.2 对空数组 + set -u 会报
# unbound variable，4.4 之前都有这个坑）。
preprod_assert_write_gates() {
  local raw="${PREPROD_APPROVED_OPEN_WRITE_GATES:-}"
  local catalog_approved=0 promo_approved=0
  local -a parts
  IFS=',' read -ra parts <<<"$raw"
  local item trimmed
  for item in ${parts[@]+"${parts[@]}"}; do
    trimmed="$(printf '%s' "$item" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "$trimmed" ]] || continue
    case "$trimmed" in
      catalog_write) catalog_approved=1 ;;
      promo_write) promo_approved=1 ;;
      *)
        echo "approved_open_write_gate_unknown value=$trimmed"
        return 65
        ;;
    esac
  done

  local feature_catalog="${FEATURE_NOVEL_CATALOG_SYNC:-}"
  local allow_catalog="${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-}"
  if [[ "$feature_catalog" != "true" && "$feature_catalog" != "false" ]] \
    || [[ "$allow_catalog" != "true" && "$allow_catalog" != "false" ]]; then
    echo "catalog_write_invalid"
    return 65
  fi

  local feature_promo="${FEATURE_PROMO_LINK_CLAIM:-}"
  local allow_promo="${PROMO_LINK_CLAIM_ALLOW_WRITE:-}"
  if [[ "$feature_promo" != "true" && "$feature_promo" != "false" ]] \
    || [[ "$allow_promo" != "true" && "$allow_promo" != "false" ]]; then
    echo "promo_write_invalid"
    return 65
  fi

  local catalog_open=0 promo_open=0
  [[ "$feature_catalog" == "true" || "$allow_catalog" == "true" ]] && catalog_open=1
  [[ "$feature_promo" == "true" || "$allow_promo" == "true" ]] && promo_open=1

  if (( catalog_open == 1 && catalog_approved == 0 )); then
    echo "catalog_write"
    return 65
  fi
  if (( promo_open == 1 && promo_approved == 0 )); then
    echo "promo_write"
    return 65
  fi

  local approved_list="" open_list=""
  if (( catalog_approved == 1 )); then approved_list="catalog_write"; fi
  if (( promo_approved == 1 )); then
    if [[ -n "$approved_list" ]]; then approved_list="$approved_list,promo_write"; else approved_list="promo_write"; fi
  fi
  [[ -n "$approved_list" ]] || approved_list="none"

  if (( catalog_open == 1 )); then open_list="catalog_write"; fi
  if (( promo_open == 1 )); then
    if [[ -n "$open_list" ]]; then open_list="$open_list,promo_write"; else open_list="promo_write"; fi
  fi
  [[ -n "$open_list" ]] || open_list="none"

  echo "PREPROD_WRITE_GATES=PASS approved=$approved_list open=$open_list"
  return 0
}

# --- 领推广链接生命周期配置门禁（阶段2 第5步，`docs/adr/
# ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`，D8） -----------------------------
#
# 背景：`src/lib/tasks/promo-claim-lifecycle.ts` 的
# `resolvePromoClaimLifecycleConfig` 对七项配置做严格解析——六个数值项
# （批准有效期/放行窗口/分片上下限/凭据安全余量/截止宽限）任何一项非法
# （非整数、越界、`shardSizeMin > shardSizeMax`）都会抛出
# `PromoClaimLifecycleConfigError`。但这个解析只在 web 入队、worker 枚举、
# scheduler 每轮 tick 时才真正被调用——尤其是 scheduler：它的 tick 循环
# 设计成"这一轮抛错、记日志、下一轮再试"（不会让配置错误崩掉整个进程），于是
# 一处配置笔误的后果不是"部署失败"而是**静默失效**：容器一直 healthy、
# 其它任务照常跑，只有生命周期分片永远不会被放行，且这条线索只在 scheduler
# 自己的日志里才看得到。preflight 因此需要在部署前用同一套规则把这类笔误
# 挡在外面。
#
# 下面六个数值判定逐条对应 `resolvePromoClaimLifecycleConfig` 里的
# `positiveInteger`/`nonNegativeInteger`：
#   - 未设置或去空白后为空串 → 用回退默认值，不算错误（`raw === undefined ||
#     raw.trim() === ""` 的逐字对应）；
#   - 否则必须是十进制整数字面量（可带前导负号），且满足正数
#     （`> 0`）或非负（`>= 0`）——对应 TS 的 `Number.isSafeInteger(parsed) &&
#     parsed > 0 / >= 0`；
#   - `shardSizeMin` 的有效值（显式或回退默认）不得超过 `shardSizeMax` 的
#     有效值。
# 🔴 刻意不追认 JS `Number()` 能解析的全部写法（科学计数法 `1e3`、十六进制
# `0x10`、前导 `+`）——环境变量里几乎不会出现这些写法，纯十进制整数正则
# 对配置笔误更保守（宁可对一个古怪写法 fail closed，也不要把它悄悄当成
# 数字接受）。`tests/backend/runtime/
# promo-claim-lifecycle-config-gate.test.ts` 的"双跑"用例只用双方都无歧义
# 同意的十进制样例（含负数/小数/非数字/空白/越界/min>max）核对两边判定一致，
# 不覆盖这类奇特写法。
#
# 🔴 与 TS 解析器唯一刻意不同的一条：开关本身。`isPromoClaimLifecycleEnabled`
# 对开关值从不报错——任何不等于精确字符串 `"true"` 的值都被 TS 静默当作
# `"false"`（fail-closed 语义上没问题，D8 要求代码默认关闭）。但这意味着
# 运营把目标机 env 里的开关笔误成 `"TRUE"`（大写）、`"1"` 这类值时，TS 侧
# 完全不会报错，只会在完全不知情的情况下继续跑着"关闭"的旧行为——这正是
# 本函数要拦的那类静默失效，只是发生在开关字段而不是数值字段。preflight
# 因此对开关额外收紧成"只接受精确的 true / false / 未设置"，比 TS 本身更
# 严格；这是有意的策略叠加，不是与 TS"不一致"——上面六个数值字段的判断规则
# 才是必须逐条对齐 TS 的部分。
#
# 🔴 2026-09-24 Opus 复核发现并修复：开关判定**不得** trim。`isPromoClaimLifecycleEnabled`
# 是 `env[...] === "true"` 严格字符串相等，同样不 trim——`" true"`（TS 侧不
# 等于 `"true"`，按 `false` 处理）如果这里先 `_pcl_trim` 再比较，会被 trim
# 成合法的 `"true"` 而 PASS 并打印 `enabled=true`，但运行时 TS 侧实际按
# `false` 跑——门禁本身制造了一次"两边判定不一致"，与这道门禁存在的目的
# （消除"preflight 说合法、运行时其实不是那么回事"）正相反。因此下面的
# `case` 直接匹配 `$enabled_raw`（未经任何 trim 的原始值），不引入
# `_pcl_trim`；只有原值恰好是空串（未设置或显式设为空）、`"true"`、`"false"`
# 三种之一才合法，首尾带任何空白、`"TRUE"`/`"1"`/`"yes"`/`"on"`/`"False"`
# 等一律 FAIL。
#
# 失败时把 `promo_claim_lifecycle_config_invalid variable=... value=...
# reason=...` 写到 stdout（供调用方转交 `fail()`）并 `return 65`；成功时
# 打印取证行 `PREPROD_PROMO_CLAIM_LIFECYCLE_CONFIG=PASS enabled=...
# approvalTtlMinutes=... ...`（沿用有效值——未设置项显示回退默认值）并
# `return 0`。
#
# 🔴 bash 3.2/5 双兼容，同 `preprod_assert_write_gates` 的约定：不用关联
# 数组、`${var,,}`；用 `10#$digits` 强制十进制求值，避免 bash 算术把
# `"008"` 这类带前导零的字面量误判成非法八进制数字（真实见过的坑：
# `(( 008 ))` 在 bash 里因为 `8`/`9` 不是合法八进制数字而直接报语法错误，
# 而 JS 的 `Number("008")` 是合法的十进制 `8`）。
_pcl_trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

_pcl_is_integer_literal() {
  [[ "$1" =~ ^-?[0-9]{1,15}$ ]]
}

# 把一个已通过 `_pcl_is_integer_literal` 校验的字面量转成十进制数值，
# 用 `10#` 前缀强制按十进制求值（见上面注释），符号单独处理以避免
# `10#-5` 这种 bash 不接受的写法。
_pcl_decimal_value() {
  local literal="$1" sign=1 digits="$1"
  if [[ "$literal" == -* ]]; then sign=-1; digits="${literal#-}"; fi
  echo $(( sign * 10#$digits ))
}

# $1=变量名（写进 reason 行）$2=原始值 $3=回退默认值 $4=positive|nonneg。
# 成功时把有效值（未设置时是回退默认值，否则是解析后的十进制数）打印到
# stdout 并 return 0；失败时把 reason 行打印到 stdout 并 return 65——与
# 下面 `preprod_assert_promo_claim_lifecycle_config` 里 "$(...)" 捕获后
# `|| { echo "$out"; return 65; }` 的用法配对，同一个函数体只会走其中一条
# 输出路径，不会两条都打印。
_pcl_resolve_integer() {
  local variable="$1" raw="$2" fallback="$3" bound="$4" trimmed value
  trimmed="$(_pcl_trim "$raw")"
  if [[ -z "$trimmed" ]]; then printf '%s' "$fallback"; return 0; fi
  if ! _pcl_is_integer_literal "$trimmed"; then
    echo "promo_claim_lifecycle_config_invalid variable=$variable value=$raw reason=not_an_integer"
    return 65
  fi
  value="$(_pcl_decimal_value "$trimmed")"
  if [[ "$bound" == "positive" ]]; then
    if (( value <= 0 )); then
      echo "promo_claim_lifecycle_config_invalid variable=$variable value=$raw reason=must_be_positive"
      return 65
    fi
  else
    if (( value < 0 )); then
      echo "promo_claim_lifecycle_config_invalid variable=$variable value=$raw reason=must_be_non_negative"
      return 65
    fi
  fi
  printf '%s' "$value"
  return 0
}

preprod_assert_promo_claim_lifecycle_config() {
  local enabled_raw enabled
  enabled_raw="${PROMO_CLAIM_LIFECYCLE_V1_ENABLED:-}"
  # 🔴 不 trim——原因见上方 2026-09-24 Opus 复核的说明。直接匹配原始值。
  case "$enabled_raw" in
    "") enabled="false" ;;
    "true") enabled="true" ;;
    "false") enabled="false" ;;
    *)
      echo "promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_LIFECYCLE_V1_ENABLED value=$enabled_raw reason=must_be_true_false_or_unset"
      return 65
      ;;
  esac

  local approval_ttl shard_window shard_min shard_max safety_margin grace out
  out="$(_pcl_resolve_integer PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES "${PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES:-}" 1440 positive)" \
    || { echo "$out"; return 65; }
  approval_ttl="$out"
  out="$(_pcl_resolve_integer PROMO_CLAIM_SHARD_WINDOW_MINUTES "${PROMO_CLAIM_SHARD_WINDOW_MINUTES:-}" 90 positive)" \
    || { echo "$out"; return 65; }
  shard_window="$out"
  out="$(_pcl_resolve_integer PROMO_CLAIM_SHARD_SIZE_MIN "${PROMO_CLAIM_SHARD_SIZE_MIN:-}" 50 positive)" \
    || { echo "$out"; return 65; }
  shard_min="$out"
  out="$(_pcl_resolve_integer PROMO_CLAIM_SHARD_SIZE_MAX "${PROMO_CLAIM_SHARD_SIZE_MAX:-}" 1000 positive)" \
    || { echo "$out"; return 65; }
  shard_max="$out"
  if (( shard_min > shard_max )); then
    echo "promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_SHARD_SIZE_MIN value=$shard_min reason=exceeds_max max=$shard_max"
    return 65
  fi
  out="$(_pcl_resolve_integer PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES "${PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES:-}" 30 nonneg)" \
    || { echo "$out"; return 65; }
  safety_margin="$out"
  out="$(_pcl_resolve_integer PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES "${PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES:-}" 10 nonneg)" \
    || { echo "$out"; return 65; }
  grace="$out"

  echo "PREPROD_PROMO_CLAIM_LIFECYCLE_CONFIG=PASS enabled=$enabled approvalTtlMinutes=$approval_ttl shardWindowMinutes=$shard_window shardSizeMin=$shard_min shardSizeMax=$shard_max credentialSafetyMarginMinutes=$safety_margin deadlineGraceMinutes=$grace"
  return 0
}

# --- MoboReader 上游按接口限速配置门禁（阶段 4-A，设计《领推广按接口限速与
# 预读集合化 · 阶段4-5》§5.6/§十三）--------------------------------------
#
# 背景与判定规则和上面 `preprod_assert_promo_claim_lifecycle_config`
# 完全同构（同一份 D8 教训：一处配置笔误如果只在运行时"悄悄变慢/变快"，很难
# 在生产被发现），因此直接复用它上方定义的 `_pcl_trim` / `_pcl_is_integer_literal`
# / `_pcl_decimal_value`（这三个是不带业务语义的十进制字面量解析工具，不是
# 生命周期专属）。开关判定的"严格 true/false/未设置、不 trim"纪律，逐字照抄
# `preprod_assert_promo_claim_lifecycle_config` 上方那条 2026-09-24 Opus 复核
# 说明——同一类静默失效，同一个修法。
#
# 六个数值项对应 `src/lib/adapters/moboreader-rate-limit.ts` 的
# `resolveMoboreaderPerEndpointRateGateConfig`：
#   - `MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC` / `__GETCODE`：
#     未设置回落到设计 §5.4/E2 的硬编码默认 1200（**不是**回落到既有共享变量
#     `MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS`——那个变量只被"其余接口"
#     沿用，见 `resolveMoboreaderPerEndpointRateGateConfig` 的
#     `defaultIntervalMs`，本门禁不校验它，它已有自己的
#     `resolveMoboreaderUpstreamRateLimitConfig` 校验路径）；必须是十进制整数
#     且 `>= 1000`（设计 §5.6 的安全下限——"防止手误把间隔配成 120"，TS 侧同一
#     下限常量 `MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS`）。
#   - `MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS`：非负整数，默认 250。
#   - `MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC` / `__GETCODE`：正整数
#     （`>= 1`，0 拒绝）——严格对齐设计 §5.6 原文"地板必须 ≥ 1"。🔴 2026-09-25
#     Opus 复核修正：上一版本这里曾写"非负整数、允许 0"，那是工单交接时的笔误，
#     不是 Owner 改口；地板是 getcode 撞 429（=结果不明）之前的主动减速保险，
#     配成 0 等于运维一个配置就能把这道保险关掉，与设计原意相反。TS 侧同步改回
#     `positiveIntegerConfig`（原为 `nonNegativeIntegerConfig`）。默认分别 8 / 12
#     （两个默认值本身早已 ≥ 1，不受此次收紧影响）。
#   - `MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS`：正整数，默认 60000。
#
# 失败时把 `moboreader_rate_gate_config_invalid variable=... value=...
# reason=...` 写到 stdout 并 `return 65`；成功时打印取证行
# `PREPROD_MOBOREADER_RATE_GATE_CONFIG=PASS enabled=... ...`（沿用有效值——
# 未设置项显示回退默认值）并 `return 0`。
_mrg_resolve_integer_min() {
  local variable="$1" raw="$2" fallback="$3" min="$4" reason="$5" trimmed value
  trimmed="$(_pcl_trim "$raw")"
  if [[ -z "$trimmed" ]]; then printf '%s' "$fallback"; return 0; fi
  if ! _pcl_is_integer_literal "$trimmed"; then
    echo "moboreader_rate_gate_config_invalid variable=$variable value=$raw reason=not_an_integer"
    return 65
  fi
  value="$(_pcl_decimal_value "$trimmed")"
  if (( value < min )); then
    echo "moboreader_rate_gate_config_invalid variable=$variable value=$raw reason=$reason"
    return 65
  fi
  printf '%s' "$value"
  return 0
}

preprod_assert_moboreader_rate_gate_config() {
  local enabled_raw enabled
  enabled_raw="${MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED:-}"
  # 🔴 不 trim——理由同 `preprod_assert_promo_claim_lifecycle_config` 上方的
  # 2026-09-24 说明，直接匹配原始值。
  case "$enabled_raw" in
    "") enabled="false" ;;
    "true") enabled="true" ;;
    "false") enabled="false" ;;
    *)
      echo "moboreader_rate_gate_config_invalid variable=MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED value=$enabled_raw reason=must_be_true_false_or_unset"
      return 65
      ;;
  esac

  local interval_getlistpc interval_getcode host_gap floor_getlistpc floor_getcode max_wait out
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC "${MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC:-}" 1200 1000 below_interval_floor)" \
    || { echo "$out"; return 65; }
  interval_getlistpc="$out"
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE "${MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE:-}" 1200 1000 below_interval_floor)" \
    || { echo "$out"; return 65; }
  interval_getcode="$out"
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS "${MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS:-}" 250 0 must_be_non_negative)" \
    || { echo "$out"; return 65; }
  host_gap="$out"
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC "${MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC:-}" 8 1 must_be_positive)" \
    || { echo "$out"; return 65; }
  floor_getlistpc="$out"
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE "${MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE:-}" 12 1 must_be_positive)" \
    || { echo "$out"; return 65; }
  floor_getcode="$out"
  out="$(_mrg_resolve_integer_min MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS "${MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS:-}" 60000 1 must_be_positive)" \
    || { echo "$out"; return 65; }
  max_wait="$out"

  echo "PREPROD_MOBOREADER_RATE_GATE_CONFIG=PASS enabled=$enabled intervalGetlistpcMs=$interval_getlistpc intervalGetcodeMs=$interval_getcode hostMinGapMs=$host_gap remainingFloorGetlistpc=$floor_getlistpc remainingFloorGetcode=$floor_getcode rateWindowMaxWaitMs=$max_wait"
  return 0
}

preprod_compose() {
  docker compose --env-file "$PREPROD_ENV_FILE" -p cps-novel \
    -f "$PREPROD_REPO_ROOT/docker-compose.yml" \
    -f "$PREPROD_REPO_ROOT/infra/preproduction/docker-compose.yml" "$@"
}

# --- Compose CLI 能力探测 ---------------------------------------------------
#
# 🔴 按 `--help` 里**真实存在的 flag** 判定，不按 `docker compose version` 的
# 版本号猜行为。
#
# 本轮 B2 事故的准确根因不是"Compose 改了 flag"——`run --no-build` 从来就不存在
# （实测 v2.24.0 / v2.29.7 / v2.32.0 / v2.36.0 / v5.0.1 / v5.5.1 全都没有，`up`
# 全都有）。它在 e274902 被写进来，而当时仓库里**没有任何测试引用过这两个入口**，
# 于是这条命令行直到在目标机上第一次真跑才第一次被执行。
# 同一个坑还有第二处：`run --pull` 在 v2.32.0 及更早也不存在（v2.36 才有），
# 所以 `--pull never` 同样按能力追加，真正承重的是 overlay 的 pull_policy: never。
# 🔴 只认 `--help` 的 flag 表那一列。裸 `grep -- "$2"` 会被描述文字里顺口提到的
# 同名 flag 骗过去——而"以为 run 支持 --no-build"正是本轮事故本身。
preprod_compose_subcommand_has_flag() {
  docker compose "$1" --help 2>/dev/null \
    | grep -qE "^[[:space:]]+(-[a-zA-Z], )?$2([[:space:]]|$)"
}

# --- 应用镜像入口的不可变工件闸门 -------------------------------------------
#
# 🔴 目标机三条硬约束，缺一不可：**不 build、不 pull、批准镜像缺失即 FAIL CLOSED**。
#
# 这三条过去全押在 CLI flag 上（`--no-build --pull never`）。那是错的，且已被实测
# 证伪：Compose v5 的 `run` 没有 `--no-build`，而只要 merged config 里还留着
# build: 段、批准镜像本地又缺失，`run --pull never` 就会**就地构建并以 0 退出**
# ——契约在没人察觉的地方失效，目标机上跑的不再是被批准的那个工件。
# （实测矩阵见 tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts，
#  v5.0.1 与 v5.5.1 行为一致。）
#
# 因此闸门下沉到三处**不依赖 flag** 的地方：
#   1) preproduction 的 merged config 里根本没有 build: 段
#      —— overlay 用 `build: !reset null` 抹掉；注意普通 `build: null` 覆盖不掉
#         基文件（实测 build 仍在），只有 `!reset` 有效；
#   2) 渲染后每个跑批准镜像的服务都必须 pull_policy: never；
#   3) 批准镜像必须已经在本地，否则拒绝 —— 绝不把"镜像缺失"这件事交给 Compose
#      去"解决"。这与 CPS 短剧的 `frozen_image_missing` 预检是同一条不变量
#      （PRODUCTION_UPDATE_SOP §15：compose 文件里有 build: 段不等于允许构建）。
preprod_assert_app_runtime_immutable() {
  # 拒绝走 stderr、PASS 走 stdout：verify-release.sh 会把 one-off 的 stdout
  # 整条 >/dev/null，拒绝理由如果走 stdout 就只剩一个裸的非零退出码。
  [[ -n "${CPS_NOVEL_APP_IMAGE:-}" ]] || {
    echo "APP_RUNTIME=REFUSED reason=app_image_unset" >&2; return 65;
  }
  local rendered
  rendered="$(preprod_compose config)" || {
    echo "APP_RUNTIME=REFUSED reason=compose_config" >&2; return 65;
  }
  # 查的是**合并结果**，不是某个文件的文本：overlay 被漏掉 -f、被替换、
  # 或被降级成不带 `!reset` 的写法，都只会在这一步暴露。
  # 服务的 build: 在渲染结果里固定是 4 空格缩进；根部 `x-app-runtime:` 扩展字段
  # 那一份是 2 空格，Compose 不会执行它，所以刻意不匹配。
  if grep -qxE ' {4}build:' <<<"$rendered"; then
    echo "APP_RUNTIME=REFUSED reason=build_capability_present" >&2; return 65
  fi
  # 🔴 "不 pull"这一条同样不能只押在 flag 上：`run --pull` 在 Compose v2.32.0
  # 及更早根本不存在。真正承重的是 overlay 的 pull_policy: never，所以这里核的是
  # **渲染后每一个跑批准镜像的服务**都带着它——overlay 掉了这一行就在这里暴露。
  local unpinned
  unpinned="$(awk -v want="$CPS_NOVEL_APP_IMAGE" '
    /^[A-Za-z0-9._-]+:[[:space:]]*$/ { section=$0; svc=""; next }
    section == "services:" && /^  [A-Za-z0-9._-]+:[[:space:]]*$/ {
      svc=$1; sub(/:$/, "", svc); order[++n]=svc; next
    }
    svc != "" && $1 == "image:" && image[svc] == "" { v=$2; gsub(/"/, "", v); image[svc]=v }
    svc != "" && $1 == "pull_policy:" { v=$2; gsub(/"/, "", v); policy[svc]=v }
    END { for (i = 1; i <= n; i++) if (image[order[i]] == want && policy[order[i]] != "never") printf "%s ", order[i] }
  ' <<<"$rendered")"
  if [[ -n "${unpinned// /}" ]]; then
    echo "APP_RUNTIME=REFUSED reason=pull_policy_not_never services=${unpinned% }" >&2; return 65
  fi
  docker image inspect "$CPS_NOVEL_APP_IMAGE" >/dev/null 2>&1 || {
    echo "APP_RUNTIME=REFUSED reason=approved_image_missing ref=$CPS_NOVEL_APP_IMAGE" >&2; return 65;
  }
  # manifest 已加载时（deploy / rollback 路径）判据升级为完整身份比对，
  # 而不只是"这个 tag 在本地存在"：retag / 同名旧缓存都要在这里被拒绝。
  if [[ -n "${PREPROD_RELEASE_TARGET_DIGEST:-}" ]]; then
    # 成功时不重复刷屏（preflight / read_manifest 已经打过 PASS），
    # 失败时把判定器的**具体 reason** 原样带出来，否则现场只剩一句笼统的拒绝。
    local identity
    if ! identity="$(preprod_assert_local_image "$CPS_NOVEL_APP_IMAGE" 2>&1)"; then
      echo "$identity" >&2
      echo "APP_RUNTIME=REFUSED reason=app_image_identity ref=$CPS_NOVEL_APP_IMAGE" >&2
      return 65
    fi
    echo "APP_RUNTIME=PASS image=$CPS_NOVEL_APP_IMAGE identity=verified"
    return 0
  fi
  # 🔴 没有 manifest 时只证明了"这个 tag 在本地存在"，没证明它就是被批准的那个
  # 工件。明说出来，别让调用方以为这条路径的身份也核过了。
  echo "APP_RUNTIME=PASS image=$CPS_NOVEL_APP_IMAGE identity=unverified_no_manifest"
  return 0
}

# 🔴 应用镜像入口一律经这两个函数。承重的是 preprod_assert_app_runtime_immutable
# 断言的那三条 merged-config / 本地镜像事实；`--pull never` 与 `--no-build` 退化为
# 锦上添花的第二道，且**只在该子命令确实支持该 flag 时**才追加——不支持就不加，
# 契约不因此变松，因为它本来就不靠 flag 站住。
#
# 🔴 目标机首次真实部署撞过的坑：`up -d` 只等**依赖项**（depends_on: condition:
# service_healthy）健康，不等被启动服务自己的 healthcheck——web 容器
# `Started` 之后不到一秒，release.sh 就调用了 verify-release.sh，那时
# /api/health 还在 502。与上面 --pull/--no-build 同一条纪律：承重的是调用方
# 在这之后显式调用的 preprod_wait_for_service_health（显式轮询
# `docker inspect` 的 .State.Health.Status，见下），不是这里追加的 --wait。
# --wait 连同 --wait-timeout 只在两者都被 --help 探测到时才追加（且用同一个
# 超时值），纯属锦上添花：探测不到就不加，正确性不因此改变。
preprod_compose_app_up() {
  preprod_assert_app_runtime_immutable || return 65
  local timeout="${PREPROD_HEALTH_WAIT_TIMEOUT_SECONDS:-180}"
  local flags=()
  if preprod_compose_subcommand_has_flag up "--pull"; then flags+=(--pull never); fi
  if preprod_compose_subcommand_has_flag up "--no-build"; then flags+=(--no-build); fi
  if preprod_compose_subcommand_has_flag up "--wait" && preprod_compose_subcommand_has_flag up "--wait-timeout"; then
    flags+=(--wait --wait-timeout "$timeout")
  fi
  preprod_compose up -d --no-deps ${flags[@]+"${flags[@]}"} "$@"
}

# one-off（migration / verify-admin-auth）与 up 共用同一套闸门和同一份 Compose
# 运行时定义——network / user / workdir / env / secrets / 挂载都来自同一个 merged
# config，不另起一套 `docker run`，避免第二套会各自漂移的运行时。
preprod_compose_app_run() {
  preprod_assert_app_runtime_immutable || return 65
  local flags=()
  if preprod_compose_subcommand_has_flag run "--pull"; then flags+=(--pull never); fi
  if preprod_compose_subcommand_has_flag run "--no-build"; then flags+=(--no-build); fi
  preprod_compose run --rm --no-deps ${flags[@]+"${flags[@]}"} "$@"
}

# --- release manifest：统一读取入口 ----------------------------------------
#
# 🔴 deploy 与 rollback 必须走同一个读取器，否则两条路径的身份校验会各自漂移。
# 🔴 解析与判定的**唯一实现**在 scripts/preproduction/image-identity.mjs。
#    这里只负责把结果搬进 shell 变量，不在 bash 里再写一份规则。
#
# 成功后导出（调用方只认这几个变量，不再自己解析 manifest）：
#   PREPROD_RELEASE_COMMIT            approved 40-hex commit
#   PREPROD_RELEASE_IMAGE_REF         交给 Compose 的镜像引用（= image_tag）
#   PREPROD_RELEASE_PLATFORM          目标平台
#   PREPROD_RELEASE_REVISION          镜像 revision 标签（== commit）
#   PREPROD_RELEASE_ARCHIVE           归档文件名（纯文件名，不含路径）
#   PREPROD_RELEASE_ARCHIVE_SHA256    归档 SHA256
#   PREPROD_RELEASE_TARGET_DIGEST     归档 index 中指向本 tag 的对象
#   PREPROD_RELEASE_TARGET_MEDIATYPE  同上的 mediaType
#   PREPROD_RELEASE_TARGET_SIZE       同上的字节数
#   PREPROD_RELEASE_MANIFEST_DIGEST   linux/amd64 实际使用的那份清单
#   PREPROD_RELEASE_CONFIG_DIGEST     清单引用的 config blob
#
# 🔴 刻意不再导出名为 PREPROD_RELEASE_IMAGE_DIGEST 的变量。那个名字没有说清
#    "哪一种 digest"，正是上一轮把 manifest digest 和 config digest 混为一谈的入口。
preprod_read_release_manifest() {
  local manifest="$1"
  [[ "$manifest" = /* ]] || { echo "MANIFEST=REFUSED reason=manifest_path_not_absolute"; return 66; }
  command -v node >/dev/null 2>&1 || { echo "MANIFEST=REFUSED reason=node_missing"; return 69; }

  local parsed status
  parsed="$(node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
    read-manifest --manifest "$manifest")"
  status=$?
  if (( status != 0 )); then echo "$parsed"; return "$status"; fi

  {
    read -r PREPROD_RELEASE_COMMIT
    read -r PREPROD_RELEASE_IMAGE_REF
    read -r PREPROD_RELEASE_PLATFORM
    read -r PREPROD_RELEASE_REVISION
    read -r PREPROD_RELEASE_ARCHIVE
    read -r PREPROD_RELEASE_ARCHIVE_SHA256
    read -r PREPROD_RELEASE_TARGET_DIGEST
    read -r PREPROD_RELEASE_TARGET_MEDIATYPE
    read -r PREPROD_RELEASE_TARGET_SIZE
    read -r PREPROD_RELEASE_MANIFEST_DIGEST
    read -r PREPROD_RELEASE_MANIFEST_MEDIATYPE
    read -r PREPROD_RELEASE_MANIFEST_SIZE
    read -r PREPROD_RELEASE_CONFIG_DIGEST
    read -r PREPROD_RELEASE_CONFIG_SIZE
  } <<<"$parsed"
  export PREPROD_RELEASE_COMMIT PREPROD_RELEASE_IMAGE_REF PREPROD_RELEASE_PLATFORM \
    PREPROD_RELEASE_REVISION PREPROD_RELEASE_ARCHIVE PREPROD_RELEASE_ARCHIVE_SHA256 \
    PREPROD_RELEASE_TARGET_DIGEST PREPROD_RELEASE_TARGET_MEDIATYPE PREPROD_RELEASE_TARGET_SIZE \
    PREPROD_RELEASE_MANIFEST_DIGEST PREPROD_RELEASE_MANIFEST_MEDIATYPE PREPROD_RELEASE_MANIFEST_SIZE \
    PREPROD_RELEASE_CONFIG_DIGEST PREPROD_RELEASE_CONFIG_SIZE
}

# --- 本地镜像身份 ----------------------------------------------------------
#
# 🔴 "manifest 指定的 digest 在本地存在"**不等于**"tag 指向它"。load 之后有人
# `docker tag` 把同名 tag 指到别的镜像，或本机早就缓存着一个同名旧 tag —— 两种
# 情况下按 digest inspect 都能成功，但 Compose 用的是 tag。所以**从 tag 出发**。
#
# 🔴 判据锚点按字段能力选，不按 Docker 版本号或 storage-driver 字符串猜：
#     有 .Descriptor（containerd image store）→ 以 Descriptor 为准，冲突即拒绝；
#     无 .Descriptor（经典 graphdriver）      → .Id 即 config digest。
# 判定逻辑在 image-identity.mjs assert-image，与构建器、preflight、deploy 同一份。
preprod_assert_local_image() {
  local ref="$1"
  local inspected
  inspected="$(docker image inspect "$ref" --format '{{json .}}' 2>/dev/null)" || {
    echo "IMAGE=REFUSED reason=image_missing ref=$ref"; return 65;
  }
  printf '%s' "$inspected" | node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
    assert-image \
    --target-digest "$PREPROD_RELEASE_TARGET_DIGEST" \
    --target-mediatype "$PREPROD_RELEASE_TARGET_MEDIATYPE" \
    --target-size "$PREPROD_RELEASE_TARGET_SIZE" \
    --config-digest "$PREPROD_RELEASE_CONFIG_DIGEST" \
    --platform "$PREPROD_RELEASE_PLATFORM" \
    --revision "$PREPROD_RELEASE_REVISION"
}

# --- 运行中容器的镜像身份 --------------------------------------------------
#
# 🔴 预检通过 ≠ 容器真的用了那个镜像。容器可能是上一轮遗留的、可能因为
# pull_policy/缓存起到了别的镜像。启动之后必须再核一次**实际容器**。
#
# 🔴 有 .ImageManifestDescriptor 时与**选中的平台 manifest** 比，而不是拿外层
# index digest 比：多平台 index 下容器跑的是某一个平台的清单，外层 digest 永远不等。
preprod_assert_container_image() {
  local service cid inspected
  for service in "$@"; do
    cid="$(preprod_compose ps -q "$service" 2>/dev/null | head -1)"
    [[ -n "$cid" ]] || { echo "RUNTIME_IMAGE=REFUSED reason=container_missing service=$service"; return 65; }
    inspected="$(docker inspect "$cid" --format '{{json .}}' 2>/dev/null)" || {
      echo "RUNTIME_IMAGE=REFUSED reason=container_uninspectable service=$service"; return 65;
    }
    printf '%s' "$inspected" | node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
      assert-container \
      --platform-manifest-digest "$PREPROD_RELEASE_MANIFEST_DIGEST" \
      --config-digest "$PREPROD_RELEASE_CONFIG_DIGEST" \
      --platform "$PREPROD_RELEASE_PLATFORM" \
      --service "$service" || return 65

    # 容器指向的镜像实体本身也要核 revision 与平台——
    # 只比对 digest 不足以说明"这个镜像是被批准那一个"。
    local image_ref
    image_ref="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null)"
    preprod_assert_local_image "$image_ref" >/dev/null || {
      echo "RUNTIME_IMAGE=REFUSED reason=container_image_identity service=$service"; return 65;
    }
  done
  echo "RUNTIME_IMAGE=PASS services=$*"
}

# --- 应用服务健康等待 --------------------------------------------------------
#
# 🔴 目标机首次真实部署的实测时间线：web 容器 StartedAt=02:27:40.594Z，
# release.sh 在 02:27:41 就调用了 verify-release.sh —— 不到一秒——那时
# /api/health 还是 502。事后重新探测：容器早已 healthy，认证过的 /api/health
# 也是 200。应用只是还没启动完；`docker compose up -d` 只等**依赖项**的
# healthcheck（depends_on: condition: service_healthy），从不等被启动服务自己
# 的。这个函数就是缺的那一等：显式轮询 `docker inspect` 的
# .State.Health.Status，直到 healthy、直到容器退出、或直到超时——三选一，
# 不会无限挂起。
#
# 🔴 与 preprod_assert_app_runtime_immutable 同一条纪律（见该函数与
# preprod_compose_app_up 上面的注释）：承重机制不押在 CLI flag 上
# （`up --wait` 在 v2.36 之前不存在，即使存在，其自身默认超时行为也不受这里
# 控制）。preprod_compose_app_up 探测到时会锦上添花地追加 --wait/--wait-timeout，
# 但让 release.sh 真正拒绝提前 verify 的是调用方显式调用的这个函数。
#
# 🔴 没有定义 healthcheck 的服务：Docker 永远不会把它标成 healthy/unhealthy——
# `.State.Health` 这个字段压根不存在。硬等一个不会出现的状态就是挂死到超时，
# 所以这里的决定是：退化为"容器处于 running"这一底线判据，立即通过。
# 三个应用服务（web/worker/scheduler）目前在 docker-compose.yml 里都定义了
# healthcheck（web 是 HTTP，worker/scheduler 是 /proc/1/cmdline 进程存活检查），
# 这个分支目前不会在生产路径触发，但函数本身必须对"未来某个服务没有
# healthcheck"这件事既不假设也不挂死。
#
# 🔴 容器已退出/崩溃：不必等到超时才失败——立刻拒绝，原因与最后已知状态
# 一并打出，比空等到超时线索更多。
#
# 拒绝走 stderr、PASS 走 stdout，与 preprod_assert_app_runtime_immutable /
# preprod_assert_container_image 同一条约定。
preprod_wait_for_service_health() {
  local timeout="${PREPROD_HEALTH_WAIT_TIMEOUT_SECONDS:-180}"
  local interval="${PREPROD_HEALTH_WAIT_INTERVAL_SECONDS:-2}"
  local service cid elapsed sample status running container_status
  for service in "$@"; do
    cid="$(preprod_compose ps -q "$service" 2>/dev/null | head -1)"
    [[ -n "$cid" ]] || {
      echo "HEALTH_WAIT=FAIL reason=container_missing service=$service" >&2; return 65;
    }
    elapsed=0
    while true; do
      sample="$(docker inspect "$cid" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.Running}}|{{.State.Status}}' \
        2>/dev/null)" || {
        echo "HEALTH_WAIT=FAIL reason=container_uninspectable service=$service" >&2; return 65;
      }
      IFS='|' read -r status running container_status <<<"$sample"

      if [[ "$status" == "none" ]]; then
        # 无 healthcheck：不可能等一个永远不会出现的状态，running 即视为就绪。
        if [[ "$running" == "true" ]]; then
          echo "HEALTH_WAIT=PASS service=$service health=no_healthcheck"
          break
        fi
      elif [[ "$status" == "healthy" ]]; then
        echo "HEALTH_WAIT=PASS service=$service health=healthy"
        break
      fi

      if [[ "$running" != "true" ]]; then
        echo "HEALTH_WAIT=FAIL reason=container_exited service=$service status=$container_status health=$status" >&2
        return 65
      fi
      if (( elapsed >= timeout )); then
        echo "HEALTH_WAIT=FAIL reason=timeout service=$service last_status=$status timeout=${timeout}s" >&2
        return 65
      fi
      sleep "$interval"
      elapsed=$(( elapsed + interval ))
    done
  done
}
