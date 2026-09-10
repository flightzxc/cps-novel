#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = path.join(root, "prisma/schema.prisma");
const migrationName = "20260816160000_p2_06_5_tagging_v3";
const migrationPath = path.join(root, "prisma/migrations", migrationName, "migration.sql");
const dictionaryPath = path.join(root, "docs/governance/database-schema-dictionary.jsonl");
const targetModels = new Set([
  "CanonicalTag",
  "CanonicalTagTranslation",
  "CanonicalTagKeyword",
  "SourceLabelMapping",
  "NovelTagState",
  "NovelCanonicalTag",
  "TagClassificationRun",
]);
const tableMeaning = {
  canonical_tag: "全局、locale-independent CanonicalTag identity 与治理状态",
  canonical_tag_translation: "CanonicalTag 的 locale display name",
  canonical_tag_keyword: "版本化 Lane C exact keyword 与 matcher metadata",
  source_label_mapping: "approved exact scoped source-label mapping edge",
  novel_tag_state: "Novel explicit automatic/manual mode、revision 与 current auto run",
  novel_canonical_tag: "Novel manual 或 auto persisted Tag snapshot row",
  tag_classification_run: "空或非空 auto snapshot 的版本化分类运行证据",
};

function physicalTableName(body, modelName) {
  return body.match(/@@map\("([^"]+)"\)/)?.[1] ?? modelName;
}

function dataType(line, prismaType) {
  const native = line.match(/@db\.(\w+)(?:\(([^)]+)\))?/) ?? [];
  if (native[1]) return `${native[1].toLowerCase()}${native[2] ? `(${native[2]})` : ""}`;
  return ({ String: "text", Int: "integer", BigInt: "bigint", Boolean: "boolean", DateTime: "timestamptz", Json: "jsonb" })[prismaType] ?? prismaType;
}

function baseRecord(stableKey, kind, entity, table) {
  return {
    stable_key: stableKey,
    record_kind: kind,
    entity,
    table_name: table,
    source: "ORIGINAL_REQUIRED",
    owner: "Codex",
    introduced_in_migration: migrationName,
    status: "active",
    evidence: [
      `prisma/migrations/${migrationName}/migration.sql`,
      "docs/adr/ADR-P2-06-5-TAGGING-V3.md",
    ],
    llm_constraints: [],
    notes: "P2-06.5 V3 Owner-accepted additive foundation; no seed or backfill",
    field_name: null,
    business_meaning: tableMeaning[table],
    data_type: kind === "table" ? "table" : null,
    nullable: false,
    default: null,
    enum_or_check: null,
    primary_key: false,
    foreign_key: null,
    on_delete: null,
    unique_constraint: [],
    indexes: [],
    sensitive_level: "S1_INTERNAL",
    read_roles: ["web_app", "worker_app", "analyst_ro", "backup_role"],
    write_roles: ["migration_owner"],
    soft_delete_policy: "no_soft_delete",
    retention_policy: "long_term",
    json_schema_version: null,
    supersedes: [],
    managed_by: kind === "constraint" ? "migration_sql" : "prisma_schema",
    physical_name: table,
  };
}

function parseModels(schema) {
  const models = [];
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, modelName, body] = match;
    if (!targetModels.has(modelName)) continue;
    const table = physicalTableName(body, modelName);
    const fields = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+(\w+)(\??)(?:\[\])?/);
      if (!field) continue;
      const [, logicalName, prismaType, optional] = field;
      if (!["String", "Int", "BigInt", "Boolean", "DateTime", "Json", "Decimal", "Bytes", "Float"].includes(prismaType)) continue;
      fields.push({
        logicalName,
        physicalName: line.match(/@map\("([^"]+)"\)/)?.[1] ?? logicalName,
        prismaType,
        optional: optional === "?",
        line,
      });
    }
    models.push({ modelName, table, fields });
  }
  return models;
}

function parseObjects(sql) {
  const objects = [];
  for (const match of sql.matchAll(/CREATE TABLE "([^"]+)"\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = match;
    for (const constraint of body.matchAll(/CONSTRAINT "([^"]+)"\s+(PRIMARY KEY|CHECK)/g)) {
      objects.push({ table, name: constraint[1], type: constraint[2] === "PRIMARY KEY" ? "primary_key" : "check" });
    }
  }
  for (const match of sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX "([^"]+)"[\s\S]*?ON "([^"]+)"/g)) {
    objects.push({ table: match[3], name: match[2], type: match[1] ? "unique_index" : "index" });
  }
  for (const match of sql.matchAll(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/g)) {
    objects.push({ table: match[1], name: match[2], type: "foreign_key" });
  }
  return objects;
}

const [schema, migration, dictionary] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(migrationPath, "utf8"),
  readFile(dictionaryPath, "utf8"),
]);
const models = parseModels(schema);
const entityByTable = new Map(models.map((model) => [model.table, model.modelName]));
const targetTables = new Set(entityByTable.keys());
const records = dictionary.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const retained = records.filter((record) => (
  !targetTables.has(record.table_name)
  && record.stable_key !== "db:public:novel_source_item:raw_language_scope"
));
const additions = [];

for (const model of models) {
  const table = baseRecord(`db:public:${model.table}`, "table", model.modelName, model.table);
  additions.push(table);
  for (const field of model.fields) {
    const record = baseRecord(`db:public:${model.table}:${field.physicalName}`, "field", model.modelName, model.table);
    record.field_name = field.physicalName;
    record.business_meaning = `${tableMeaning[model.table]}：${field.physicalName}`;
    record.data_type = dataType(field.line, field.prismaType);
    record.nullable = field.optional;
    record.default = field.line.match(/@default\(([^)]+)\)/)?.[1] ?? null;
    record.primary_key = field.line.includes("@id");
    record.json_schema_version = field.prismaType === "Json" ? 1 : null;
    additions.push(record);
  }
}

const rawScope = baseRecord(
  "db:public:novel_source_item:raw_language_scope",
  "field",
  "NovelSourceItem",
  "novel_source_item",
);
rawScope.field_name = "raw_language_scope";
rawScope.business_meaning = "由 RAW_LANGUAGE_SCOPE_V1 从原始 payload 精确派生的 nullable source scope";
rawScope.data_type = "text";
rawScope.nullable = true;
rawScope.read_roles = ["web_app", "worker_app", "analyst_ro", "backup_role"];
rawScope.write_roles = ["migration_owner", "worker_app"];
additions.push(rawScope);

for (const object of parseObjects(migration).filter((item) => targetTables.has(item.table))) {
  const record = baseRecord(`db:public:${object.table}:${object.name}`, "constraint", entityByTable.get(object.table), object.table);
  record.business_meaning = object.name;
  record.data_type = object.type;
  record.primary_key = object.type === "primary_key";
  record.foreign_key = object.type === "foreign_key" ? object.name : null;
  record.unique_constraint = object.type === "unique_index" ? [object.name] : [];
  record.indexes = object.type.includes("index") ? [object.name] : [];
  record.physical_name = object.name;
  additions.push(record);
}

const output = [...retained, ...additions].map((record) => JSON.stringify(record)).join("\n") + "\n";
await writeFile(dictionaryPath, output, "utf8");
process.stdout.write(`${JSON.stringify({ status: "ok", retained: retained.length, added: additions.length })}\n`);

