#!/usr/bin/env node
import { readFileSync } from "node:fs";

const expectedHeader = "name\tconsumer_class\tuid\tgid";
const consumers = new Map([
  ["APP", ["1001", "1001"]],
  ["POSTGRES", ["999", "999"]],
  ["HOST_NGINX", ["33", "33"]],
  ["HOST_DEPLOY", ["1000", "1000"]],
  ["BACKUP_ROOT", ["0", "0"]],
]);

function fail(reason) {
  process.stdout.write(`SECRET_CONSUMER_MATRIX=FAIL reason=${reason}\n`);
  process.exit(65);
}

function lines(file) {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  } catch {
    fail("unreadable_input");
  }
}

const [inventoryPath, matrixPath] = process.argv.slice(2);
if (!inventoryPath || !matrixPath || process.argv.length !== 4) fail("usage");

const inventory = lines(inventoryPath);
const matrix = lines(matrixPath);
if (matrix[0] !== expectedHeader) fail("invalid_header");

const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const inventoryNames = new Set();
for (const name of inventory) {
  if (!filename.test(name)) fail("invalid_inventory_name");
  if (inventoryNames.has(name)) fail("duplicate_inventory");
  inventoryNames.add(name);
}

const assignments = new Set();
for (const row of matrix.slice(1)) {
  const columns = row.split("\t");
  if (columns.length !== 4) fail("invalid_row");
  const [name, consumer, uid, gid] = columns;
  if (!filename.test(name)) fail("invalid_matrix_name");
  if (assignments.has(name)) fail("duplicate_assignment");
  assignments.add(name);

  const identity = consumers.get(consumer);
  if (!identity) fail("unknown_consumer_class");
  if (uid !== identity[0] || gid !== identity[1]) fail("consumer_identity_mismatch");
  if (!inventoryNames.has(name)) fail("unknown_secret");
}

for (const name of inventoryNames) {
  if (!assignments.has(name)) fail("unclassified_secret");
}
if (assignments.size !== inventoryNames.size) fail("inventory_matrix_mismatch");

process.stdout.write(`SECRET_CONSUMER_MATRIX=PASS count=${assignments.size}\n`);
