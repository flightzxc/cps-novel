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

/**
 * v0.6.2 按书归因：同一个 `GetReport`，维度 `["1","8"]`（日期 → 网文|短剧，即具体到书）。
 * 上游 `GetSelectItems` 实测的日报维度编码（10-17 主控只读实测）：1 日期、2 月份、3 业务类型、4 授权产品、
 * 5 机构名称、7 口令、8 网文|短剧、9 业务模式、12 国内/海外。
 * **维度 7（口令）永远不取**：PlotNovel 的口令码是 6 位纯数字，禁止落库或出现在任何输出里——
 * 请求体只能由下面两组冻结的维度组合构造（见 `buildNovelGetReportBody`），没有任何入口能拼出含 "7" 的请求。
 */
export const NOVEL_REVENUE_DIMENSION_DATE = "1" as const;
export const NOVEL_REVENUE_DIMENSION_BOOK = "8" as const;
export const NOVEL_REVENUE_BOOK_DIMENSIONS = Object.freeze(["1", "8"] as const);

/**
 * v0.6.2 新增用户国家：`POST /api/Report/GetCountryReport`，对日报的某一行下钻（上游前端就是这么调的）。
 * 只按「日期行」下钻（总计行 dimension=0 上游返回空列表）；`countryReportType`：0 激活、1 新用户、2 收入。
 * 本期只取新用户（Owner 10-17：看新增用户来自哪个国家）。
 */
export const NOVEL_REVENUE_COUNTRY_REPORT_PATH = "/api/Report/GetCountryReport";
export const NOVEL_REVENUE_COUNTRY_ENDPOINT = `${NOVEL_REVENUE_ORIGIN}${NOVEL_REVENUE_COUNTRY_REPORT_PATH}`;
export const NOVEL_REVENUE_COUNTRY_REPORT_TYPE_NEW_USERS = 1 as const;
