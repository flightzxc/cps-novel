-- PN-15 前台站内搜索（Owner 2026-10-09 拍板"开关加，最好做在后台"）：
-- 后台"站点设置"新增受管字段"前台站内搜索开关"。CPS 对应物是环境变量
-- FEATURE_SITE_SEARCH，海阅改为后台受管字段（NOVEL_ADAPTED）。
-- 只做追加，不改任何已有迁移；默认 false = 关闭（搜索页 404 + noindex,nofollow、
-- 页头入口不渲染）。应用层只接受 JSON 布尔值，校验在 src/server/site-settings/service.ts。
ALTER TABLE "site_setting"
  ADD COLUMN "site_search_enabled" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "site_setting"."site_search_enabled" IS
  'Front-end site search switch; true means the public site search is open, false (default) means the search page returns 404 and the header entry is not rendered.';
