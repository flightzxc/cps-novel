-- 运营 V2 需求（Owner 2026-09-30）：后台"站点设置"新增两个 Yandex 输入项。
-- 两列都只做追加，不改任何已有迁移；应用层校验（验证码 [A-Za-z0-9_-]{1,255}、
-- Metrica ID 1～12 位数字）在 src/server/site-settings/service.ts，渲染时再校验一次。
ALTER TABLE "site_setting"
  ADD COLUMN "yandex_verification" VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN "yandex_metrica_id" VARCHAR(32);

COMMENT ON COLUMN "site_setting"."yandex_verification" IS
  'Yandex webmaster verification code; empty string means no meta tag is rendered.';
COMMENT ON COLUMN "site_setting"."yandex_metrica_id" IS
  'Yandex Metrica counter id (digits only); NULL means no counter code is rendered.';
