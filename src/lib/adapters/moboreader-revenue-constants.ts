/**
 * 收益接口的常量，单独成文件：纯常量、零依赖，web 侧（任务参数校验、入队、读服务）与 worker 侧
 * （适配器）都从这里取，避免 web 为了拿一个 `projectType` 常量把适配器连同它的限速闸单例一起引进来。
 * 对外仍由 `./moboreader-revenue` 原样再导出。
 * 接口是账号级的，覆盖该畅读账号下全部网文应用（文件名里的 `moboreader-` 指 kocserver 上游适配器家族）。
 */

/** 网文 projectType。海阅仓库里没有现成的同名常量，这里是唯一定义点。 */
export const NOVEL_REVENUE_PROJECT_TYPE = 1 as const;
export const NOVEL_REVENUE_ORIGIN = "https://kocserver-cn.cdreader.com";
export const NOVEL_REVENUE_REPORT_PATH = "/api/Report/GetReport";
export const NOVEL_REVENUE_ENDPOINT = `${NOVEL_REVENUE_ORIGIN}${NOVEL_REVENUE_REPORT_PATH}`;
export const NOVEL_REVENUE_DIMENSIONS = Object.freeze(["1"] as const);
export const NOVEL_REVENUE_PAGE_SIZE = 999;
export const NOVEL_REVENUE_MAX_PAGES = 10;
