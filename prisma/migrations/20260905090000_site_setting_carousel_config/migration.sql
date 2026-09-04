ALTER TABLE "site_setting"
  ADD COLUMN "carousel_config_json" JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "site_setting"."carousel_config_json" IS
  'Home carousel operating config; revenue ranking remains hard-disabled for Novel V1.';
