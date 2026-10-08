/** Runtime and deployment share this dependency-free policy. */
export const MOBOREADER_UPSTREAM_TASK_TYPES = Object.freeze([
  "catalog_scan", "moboreader.preview_refresh.v1", "promo_link.claim.v1",
  // 收益看板·账号级每日汇总：调用畅读 GetReport，所以和上面几个一样只能放主通道白名单。
  "moboreader.revenue_sync.v1",
]);
export const APPROVED_LIGHT_TASK_TYPES = Object.freeze([
  "sitemap_refresh", "sitemap.daily_fallback.v1", "home_carousel.compute.v1",
  "indexnow.sweep.v1", "indexnow_delivery",
  // 文章后台批量发布（2026-10-06）：只做数据库操作、不调上游。放在轻量通道是因为主
  // worker 每一轮都先处理试读抓取，发布子任务建出来的试读任务会插队，后面的发布要等
  // 十几个小时。只能出现在 WORKER_LIGHT_TASK_ALLOWLIST，不能出现在主通道白名单。
  "article.publish.batch.v1", "article.publish.v1",
]);
export function parseWorkerLane(raw) {
  const lane = raw ?? "main";
  if (lane !== "main" && lane !== "light") throw new Error(`worker_lane_invalid: ${lane}`);
  return lane;
}
export function assertWorkerLane(lane, effective) {
  parseWorkerLane(lane);
  if (lane === "main") {
    const forbidden = effective.filter(type => type === "indexnow.sweep.v1" || type === "indexnow_delivery");
    if (forbidden.length) throw new Error(`worker_main_indexnow_forbidden: ${forbidden.join(",")}`);
    return;
  }
  const upstream = effective.filter(type => MOBOREADER_UPSTREAM_TASK_TYPES.includes(type));
  if (upstream.length) throw new Error(`worker_light_upstream_forbidden: ${upstream.join(",")}`);
  const unapproved = effective.filter(type => !APPROVED_LIGHT_TASK_TYPES.includes(type));
  if (unapproved.length) throw new Error(`worker_light_task_unapproved: ${unapproved.join(",")}`);
}
export function parseTaskTypes(raw) {
  return [...new Set((raw ?? "").split(/[,\s]+/).filter(Boolean))];
}
export function validateWorkerLaneEnvironment(env) {
  if (parseWorkerLane(env.WORKER_LANE) !== "main") throw new Error("worker_main_lane_required");
  const main = parseTaskTypes(env.WORKER_TASK_ALLOWLIST);
  const light = parseTaskTypes(env.WORKER_LIGHT_TASK_ALLOWLIST);
  if (!main.length || !light.length) throw new Error("worker_lane_allowlist_empty");
  const mainId = env.WORKER_ID?.trim();
  const lightId = env.WORKER_LIGHT_ID?.trim();
  if (!mainId || !lightId) throw new Error("worker_lane_id_required");
  if (mainId === lightId) throw new Error("worker_lane_id_overlap");
  const overlap = main.filter(type => light.includes(type));
  if (overlap.length) throw new Error(`worker_lane_allowlist_overlap: ${overlap.join(",")}`);
  assertWorkerLane("main", main);
  assertWorkerLane("light", light);
  return { main, light, mainId, lightId };
}
