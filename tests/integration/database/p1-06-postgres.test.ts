import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.P1_06_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("P1_06_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("P1_06_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("P1_06_WORKER_DATABASE_URL") });
const analyst = new PrismaClient({ datasourceUrl: requiredUrl("P1_06_ANALYST_DATABASE_URL") });
const backup = new PrismaClient({ datasourceUrl: requiredUrl("P1_06_BACKUP_DATABASE_URL") });

const ids = {
  channel: randomUUID(),
  sourceApp: randomUUID(),
  channelApp: randomUUID(),
  account: randomUUID(),
  credential: randomUUID(),
  task: randomUUID(),
  item: randomUUID(),
};
const suffix = randomBytes(8).toString("hex");

async function expectDenied(action: () => Promise<unknown>) {
  await expect(action()).rejects.toThrow();
}

describe.skipIf(!enabled).sequential("P1-06 PostgreSQL role enforcement", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await owner.$queryRawUnsafe<Array<{ database_name: string }>>(
      "SELECT current_database() AS database_name",
    );
    if (!databaseName.includes("p1_06") && !databaseName.startsWith("cps_novel_restore_")) {
      throw new Error(`Refusing P1-06 setup against ${databaseName}`);
    }

    await owner.$executeRaw`
      INSERT INTO channel (id, code, name, updated_at)
      VALUES (${ids.channel}::uuid, ${`p106-${suffix}`}, 'P1-06 Channel', now())
    `;
    await owner.$executeRaw`
      INSERT INTO source_app (id, code, name, updated_at)
      VALUES (${ids.sourceApp}::uuid, ${`p106-source-${suffix}`}, 'P1-06 Source', now())
    `;
    await owner.$executeRaw`
      INSERT INTO channel_app (
        id, channel_id, source_app_id, external_app_id, project_type, updated_at
      ) VALUES (
        ${ids.channelApp}::uuid, ${ids.channel}::uuid, ${ids.sourceApp}::uuid,
        ${`p106-app-${suffix}`}, 2, now()
      )
    `;
    await owner.$executeRaw`
      INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
      VALUES (
        ${ids.account}::uuid, ${ids.channel}::uuid, ${`p106-account-${suffix}`},
        'P1-06 Account', now()
      )
    `;
    await owner.$executeRaw`
      INSERT INTO channel_account_credential (
        id, channel_account_id, encrypted_secret, key_version, secret_fingerprint,
        fingerprint_prefix, status, updated_at
      ) VALUES (
        ${ids.credential}::uuid, ${ids.account}::uuid, ${randomBytes(32)}, 1,
        ${randomBytes(32).toString("hex")}, ${randomBytes(4).toString("hex")},
        'active', now()
      )
    `;
    await owner.$executeRaw`
      INSERT INTO generic_task (
        id, task_type, operation_scope_hash, request_token, status, updated_at
      ) VALUES (
        ${ids.task}::uuid, 'p1_06_permission_probe', ${randomBytes(32).toString("hex")},
        ${`p106-request-${suffix}`}, 'pending', now()
      )
    `;
    await owner.$executeRaw`
      INSERT INTO generic_task_item (id, task_id, target_type, target_id, status, updated_at)
      VALUES (${ids.item}::uuid, ${ids.task}::uuid, 'permission_probe', ${suffix}, 'pending', now())
    `;
  }, 30_000);

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), analyst.$disconnect(), backup.$disconnect()]);
  });

  it("never runs an application connection as migration_owner", async () => {
    const clients = [web, worker, analyst, backup];
    const expected = ["web_app", "worker_app", "analyst_ro", "backup_role"];
    for (let index = 0; index < clients.length; index += 1) {
      const [{ current_user: currentUser }] = await clients[index].$queryRawUnsafe<Array<{ current_user: string }>>(
        "SELECT current_user",
      );
      expect(currentUser).toBe(expected[index]);
      expect(currentUser).not.toBe("migration_owner");
    }
  });

  it("allows Web ciphertext INSERT but blocks persisted ciphertext SELECT and DDL", async () => {
    const webCredentialId = randomUUID();
    await web.$executeRaw`
      INSERT INTO channel_account_credential (
        id, channel_account_id, credential_type, encrypted_secret, key_version,
        secret_fingerprint, fingerprint_prefix, status, updated_at
      ) VALUES (
        ${webCredentialId}::uuid, ${ids.account}::uuid, 'bearer_jwt',
        ${randomBytes(32)}, 1, ${randomBytes(32).toString("hex")},
        ${randomBytes(4).toString("hex")}, 'invalid', now()
      )
    `;
    expect(await owner.channelAccountCredential.count({ where: { id: webCredentialId } })).toBe(1);
    await expectDenied(() => web.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"));
    await expectDenied(() => web.$queryRawUnsafe("SELECT * FROM channel_account_credential LIMIT 1"));
    await expectDenied(() => web.$executeRawUnsafe("CREATE TABLE p1_06_web_ddl_probe (id integer)"));
    const rows = await web.$queryRawUnsafe<Array<{ fingerprint_prefix: string }>>(
      "SELECT fingerprint_prefix FROM channel_account_credential LIMIT 1",
    );
    expect(rows).toHaveLength(1);
  });

  it("enforces Analyst read-only, timeout, and secret visibility", async () => {
    const settings = await analyst.$queryRawUnsafe<Array<{ statement_timeout: string; read_only: string }>>(
      "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('default_transaction_read_only') AS read_only",
    );
    expect(settings).toEqual([{ statement_timeout: "30s", read_only: "on" }]);
    await expectDenied(() => analyst.$executeRawUnsafe("INSERT INTO channel (id, code, name, updated_at) VALUES (gen_random_uuid(), 'denied', 'denied', now())"));
    await expectDenied(() => analyst.$executeRawUnsafe("UPDATE channel SET name = 'denied'"));
    await expectDenied(() => analyst.$executeRawUnsafe("DELETE FROM channel"));
    await expectDenied(() => analyst.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"));
    await expectDenied(() => analyst.$queryRawUnsafe("SELECT * FROM channel_account_credential LIMIT 1"));
    expect(await analyst.$queryRawUnsafe("SELECT id, code FROM channel LIMIT 1")).toHaveLength(1);
  });

  it("prevents application roles from mutating operation_audit", async () => {
    const [{ id }] = await owner.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO operation_audit (actor_type, action, entity_type, entity_id)
       VALUES ('p1_06', 'seed', 'GenericTask', '${ids.task}') RETURNING id`,
    );
    for (const client of [web, worker]) {
      await expectDenied(() => client.$executeRawUnsafe(`UPDATE operation_audit SET action = 'denied' WHERE id = ${id}`));
      await expectDenied(() => client.$executeRawUnsafe(`DELETE FROM operation_audit WHERE id = ${id}`));
    }
  });

  it("allows Worker minimum credential, claim, fenced write, and audit operations", async () => {
    const executionToken = randomUUID();
    const secretRows = await worker.$queryRawUnsafe<Array<{ encrypted_secret: Uint8Array }>>(
      "SELECT encrypted_secret FROM channel_account_credential LIMIT 1",
    );
    expect(secretRows[0].encrypted_secret.byteLength).toBeGreaterThan(0);

    await worker.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE generic_task_item
        SET status = 'processing', attempt_count = attempt_count + 1,
            execution_token = ${executionToken}::uuid, lease_epoch = lease_epoch + 1,
            locked_by = 'p1-06-worker', locked_until = transaction_timestamp() + interval '1 minute',
            heartbeat_at = transaction_timestamp(), started_at = transaction_timestamp(),
            updated_at = transaction_timestamp()
        WHERE id = ${ids.item}::uuid AND status = 'pending'
        RETURNING id
      `;
      expect(claimed).toEqual([{ id: ids.item }]);
      await tx.$executeRaw`
        INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id, task_type, task_id)
        VALUES ('worker', 'p1-06-worker', 'claim', 'GenericTaskItem', ${ids.item}, 'p1_06_permission_probe', ${ids.task}::uuid)
      `;
    });
  });

  it("keeps Backup read-only and all runtime roles without schema CREATE", async () => {
    expect(await backup.$queryRawUnsafe("SELECT count(*) FROM channel_account_credential")).toHaveLength(1);
    await expectDenied(() => backup.$executeRawUnsafe("UPDATE channel SET name = 'denied'"));
    await expectDenied(() => backup.$executeRawUnsafe("CREATE TABLE p1_06_backup_ddl_probe (id integer)"));

    const privileges = await owner.$queryRawUnsafe<Array<{ role_name: string; can_create: boolean }>>(`
      SELECT role_name, has_schema_privilege(role_name, 'public', 'CREATE') AS can_create
      FROM unnest(ARRAY['web_app','worker_app','analyst_ro','backup_role']) role_name
      ORDER BY role_name
    `);
    expect(privileges.every(({ can_create: canCreate }) => canCreate === false)).toBe(true);
  });
});
