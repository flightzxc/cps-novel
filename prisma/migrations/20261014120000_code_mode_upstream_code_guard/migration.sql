-- v0.6.0 PlotNovel 口令码剧场——把"web_app 能读所有推广码"收紧到数据库层
-- (docs/adr/ADR-V060-PLOTNOVEL-CODE-THEATER.md D8；Owner 2026-10-14 "按数据库层收紧")。
--
-- 背景：口令码模式的中间页 /go/<站内码>/app 要把上游口令码展示给读者，原先靠 grants.sql 给 web_app 开
-- promo_link.upstream_code 的列级 SELECT——但列级授权按行无法限制，web_app 在数据库层就能读到**所有**推广链接
-- （含 MoboReader）的口令码。本迁移改成：
--
--   1. web_app 不再有 upstream_code 的任何读权限（grants.sql 里撤掉）；
--   2. 就绪判断本来只需要知道"口令码是否非空"，所以新增一个**只表示有没有**的布尔列 upstream_code_present，
--      由触发器在每次 INSERT / UPDATE 时重算（任何写入方都改不了它），web_app 只读这一列；
--   3. 中间页要显示的口令码，只能经下面的 SECURITY DEFINER 函数 code_mode_upstream_code(站内码) 取：
--      给一个站内码，只有它属于口令码模式剧场、且按就绪规则就绪时才返回那一条的口令码，否则 NULL；
--      一次只回答一个站内码，不是集合返回函数，没有任何可枚举的接口。
--
-- 角色与授权：函数属主就是执行迁移的 migration_owner（本仓库迁移的统一执行身份，grants.sql 也由它重放）。
-- 本迁移只做 REVOKE ALL ... FROM PUBLIC；对 web_app 的 EXECUTE 授权写在 infra/postgres/grants.sql——
-- grants.sql 每次迁移后重放，开头会 REVOKE ALL ON ALL FUNCTIONS FROM web_app 等，迁移里授的权会被它抹掉。
--
-- 空白字符集：下面三处用到的 25 个字符就是 ECMAScript String.prototype.trim 去掉的那一套
-- （src/server/publication/visibility.ts 的 JS_TRIM_WHITESPACE_CHARACTERS；PostgreSQL 的默认 btrim 只去空格），
-- 由 tests/backend/publication/js-trim-whitespace-set.test.ts 逐码点核对与迁移文件里的字面量一致。

-- ---------------------------------------------------------------------------
-- 1. 只表示"有没有口令码"的布尔列（不含口令码本身，web_app 可读）
-- ---------------------------------------------------------------------------
ALTER TABLE "promo_link" ADD COLUMN "upstream_code_present" BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION public.promo_link_sync_upstream_code_present()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  -- 与 JS 的 isNonBlank（trim 后长度 > 0）逐字等价；无论写入方给没给这一列，都按 upstream_code 重算。
  NEW.upstream_code_present := coalesce(pg_catalog.btrim(NEW.upstream_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') <> '';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.promo_link_sync_upstream_code_present() FROM PUBLIC;

CREATE TRIGGER promo_link_upstream_code_present_sync
BEFORE INSERT OR UPDATE ON public.promo_link
FOR EACH ROW
EXECUTE FUNCTION public.promo_link_sync_upstream_code_present();

-- 回填：把现有行的 upstream_code 原值写回自己，触发器据此重算 upstream_code_present
-- （不另抄一份表达式；不碰 updated_at，站点地图 lastmod 不受影响）。
UPDATE public.promo_link SET upstream_code = upstream_code WHERE upstream_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. 口令码中间页取码函数：给一个站内码，只在"口令码模式 + 就绪"时返回口令码
-- ---------------------------------------------------------------------------
-- 规则逐条对应 src/server/publication/visibility.ts 的口令码分支（isPromoReady / promoReadySql）：
--   未删除 ∧ status = 'fetched' ∧ 剧场 config.promoMode = 'code' ∧ 口令码去空白后非空（upstream_code_present）
--   ∧ 书的语种非空且是剧场 config.codeModeLocales 数组里的一项（元素按原样比较）。
-- 其它任何情况（link 模式、查无此码、未就绪）都返回 NULL。
CREATE FUNCTION public.code_mode_upstream_code(p_public_redirect_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.upstream_code
  FROM public.promo_link p
  JOIN public.channel_app ca ON ca.id = p.channel_app_id
  JOIN public.novel n ON n.id = p.novel_id
  WHERE p.public_redirect_code = p_public_redirect_code
    AND p.deleted_at IS NULL
    AND p.status = 'fetched'
    AND ca.config->>'promoMode' = 'code'
    AND p.upstream_code_present
    AND coalesce(n.locale, '') <> ''
    AND coalesce(jsonb_typeof(ca.config->'codeModeLocales'), '') = 'array'
    AND jsonb_exists(ca.config->'codeModeLocales', n.locale)
$$;

REVOKE ALL ON FUNCTION public.code_mode_upstream_code(text) FROM PUBLIC;
