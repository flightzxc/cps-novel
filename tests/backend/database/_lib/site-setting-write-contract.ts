import { Prisma } from "@prisma/client";

import { SITE_SETTING_WRITABLE_FIELDS } from "@/server/site-settings/service";
import { HOME_CAROUSEL_SITE_SETTING_WRITABLE_FIELDS } from "@/server/home-carousel/service";

/** Derive SQL columns from the actual service allowlists and Prisma metadata. */
export function managedSiteSettingUpdateColumns(): string[] {
  const model = Prisma.dmmf.datamodel.models.find(({ name }) => name === "SiteSetting")!;
  const managedFields = [
    ...SITE_SETTING_WRITABLE_FIELDS,
    ...HOME_CAROUSEL_SITE_SETTING_WRITABLE_FIELDS,
    ...model.fields.filter((field) => field.isUpdatedAt).map((field) => field.name),
  ];
  return managedFields.map((name) => {
    const field = model.fields.find((candidate) => candidate.name === name);
    if (!field) throw new Error(`Unknown managed SiteSetting field: ${name}`);
    return field.dbName ?? field.name;
  }).sort();
}
