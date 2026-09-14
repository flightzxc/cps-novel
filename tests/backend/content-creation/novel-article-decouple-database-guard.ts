export const ISOLATED_DECOUPLE_DATABASE_PREFIX = "cps_novel_article_decouple_";

export const FORBIDDEN_DATABASE_NAME_FRAGMENTS = [
  "cps_novel_x8",
  "cps_novel_uat",
  "cps_novel_prod",
  "cps_novel_catalog_batch_",
  "p1_06",
] as const;

export function assertIsolatedDecoupleDatabaseName(name: string): void {
  if (!name.startsWith(ISOLATED_DECOUPLE_DATABASE_PREFIX)) {
    throw new Error(`Refusing novel-article-decouple setup against ${name}`);
  }
  if (FORBIDDEN_DATABASE_NAME_FRAGMENTS.some((fragment) => name.includes(fragment.replace(/_$/, "")))) {
    throw new Error(`Refusing shared/non-disposable database ${name}`);
  }
}

export function assertRoleClientsShareIsolatedDatabase(input: {
  readonly ownerDatabase: string;
  readonly webDatabase: string;
  readonly workerDatabase: string;
}): void {
  assertIsolatedDecoupleDatabaseName(input.ownerDatabase);
  assertIsolatedDecoupleDatabaseName(input.webDatabase);
  assertIsolatedDecoupleDatabaseName(input.workerDatabase);
  if (input.ownerDatabase !== input.webDatabase || input.ownerDatabase !== input.workerDatabase) {
    throw new Error(
      `Role clients must share one isolated database; got owner=${input.ownerDatabase} web=${input.webDatabase} worker=${input.workerDatabase}`,
    );
  }
}
