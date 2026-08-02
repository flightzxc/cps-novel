#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "prisma/schema.prisma");
const dictionaryPath = path.join(
  root,
  "docs/governance/database-schema-dictionary.jsonl",
);
const staticOnly = process.argv.includes("--static");

function fail(messages) {
  const problems = Array.isArray(messages) ? messages : [messages];
  throw new Error(`Database dictionary drift:\n- ${problems.join("\n- ")}`);
}

function physicalTableName(modelBody, modelName) {
  return modelBody.match(/@@map\("([^"]+)"\)/)?.[1] ?? modelName;
}

function parseSchema(schema) {
  const tables = new Map();
  const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const match of schema.matchAll(modelPattern)) {
    const [, modelName, body] = match;
    const tableName = physicalTableName(body, modelName);
    const fields = new Set();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+([^\s]+)/);
      if (!field) continue;
      const [, logicalName, prismaType] = field;
      const baseType = prismaType.replace(/[?\[\]]/g, "");
      const scalarTypes = new Set([
        "String",
        "Int",
        "BigInt",
        "Boolean",
        "DateTime",
        "Decimal",
        "Json",
        "Bytes",
        "Float",
      ]);
      if (!scalarTypes.has(baseType)) continue;
      const mappedName = line.match(/@map\("([^"]+)"\)/)?.[1] ?? logicalName;
      fields.add(mappedName);
    }
    tables.set(tableName, fields);
  }
  return tables;
}

function parseDictionary(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function assertStaticConsistency(schemaTables, records) {
  const problems = [];
  const keys = new Set();
  for (const record of records) {
    if (keys.has(record.stable_key)) {
      problems.push(`duplicate stable_key ${record.stable_key}`);
    }
    keys.add(record.stable_key);
  }

  const active = records.filter((record) => record.status === "active");
  const tableRecords = new Set(
    active
      .filter((record) => record.record_kind === "table")
      .map((record) => record.table_name),
  );
  const fieldRecords = new Set(
    active
      .filter((record) => record.record_kind === "field")
      .map((record) => `${record.table_name}.${record.field_name}`),
  );

  for (const [tableName, fields] of schemaTables) {
    if (!tableRecords.has(tableName)) problems.push(`orphan Schema table ${tableName}`);
    for (const fieldName of fields) {
      if (!fieldRecords.has(`${tableName}.${fieldName}`)) {
        problems.push(`orphan Schema field ${tableName}.${fieldName}`);
      }
    }
  }

  for (const record of active) {
    if (record.record_kind === "table" && !schemaTables.has(record.table_name)) {
      problems.push(`ghost dictionary table ${record.table_name}`);
    }
    if (
      record.record_kind === "field" &&
      !schemaTables.get(record.table_name)?.has(record.field_name)
    ) {
      problems.push(`ghost dictionary field ${record.table_name}.${record.field_name}`);
    }
    if (
      record.record_kind === "constraint" &&
      record.managed_by !== "application_contract" &&
      !record.physical_name
    ) {
      problems.push(`database object without physical_name ${record.stable_key}`);
    }
  }

  if (schemaTables.size !== 37) {
    problems.push(`expected 37 Prisma models, found ${schemaTables.size}`);
  }
  if (problems.length) fail(problems);
  return { recordCount: records.length, activeCount: active.length };
}

async function assertCatalogConsistency(records) {
  const prisma = new PrismaClient();
  try {
    const [tables, columns, constraints, indexes, triggers] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT tablename AS name
        FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public' AND r.relname <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT t.tgname AS name
        FROM pg_trigger t
        JOIN pg_class r ON r.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
      `),
    ]);

    const actualTables = new Set(tables.map(({ name }) => name));
    const actualColumns = new Set(
      columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
    );
    const actualConstraints = new Set(constraints.map(({ name }) => name));
    const actualIndexes = new Set(indexes.map(({ name }) => name));
    const actualTriggers = new Set(triggers.map(({ name }) => name));
    const expectedPhysical = new Set();
    const problems = [];

    for (const record of records.filter((item) => item.status === "active")) {
      if (record.record_kind === "table" && !actualTables.has(record.table_name)) {
        problems.push(`dictionary table missing from database ${record.table_name}`);
      }
      if (
        record.record_kind === "field" &&
        !actualColumns.has(`${record.table_name}.${record.field_name}`)
      ) {
        problems.push(`dictionary field missing from database ${record.table_name}.${record.field_name}`);
      }
      if (record.record_kind !== "constraint" || record.managed_by === "application_contract") {
        continue;
      }
      expectedPhysical.add(record.physical_name);
      const type = record.data_type;
      const exists =
        type === "trigger" || type === "permission_trigger"
          ? actualTriggers.has(record.physical_name)
          : type.includes("index") || type === "unique" || type === "unique_retention"
            ? actualIndexes.has(record.physical_name)
            : actualConstraints.has(record.physical_name) || actualIndexes.has(record.physical_name);
      if (!exists) problems.push(`dictionary database object missing ${record.physical_name}`);
    }

    for (const name of [...actualConstraints, ...actualIndexes, ...actualTriggers]) {
      if (!expectedPhysical.has(name)) problems.push(`database object missing from dictionary ${name}`);
    }
    if (actualTables.size !== 37) problems.push(`expected 37 database tables, found ${actualTables.size}`);
    if (problems.length) fail(problems);
    return {
      tableCount: actualTables.size,
      constraintCount: actualConstraints.size,
      indexCount: actualIndexes.size,
      triggerCount: actualTriggers.size,
    };
  } finally {
    await prisma.$disconnect();
  }
}

const [schema, dictionaryText] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(dictionaryPath, "utf8"),
]);
const schemaTables = parseSchema(schema);
const records = parseDictionary(dictionaryText);
const staticResult = assertStaticConsistency(schemaTables, records);
const catalogResult = staticOnly ? null : await assertCatalogConsistency(records);

process.stdout.write(
  `${JSON.stringify({ status: "ok", models: schemaTables.size, ...staticResult, ...catalogResult })}\n`,
);
