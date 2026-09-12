import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Structural regression guard for the bug fixed alongside this test:
 * `src/app/(admin)/articles/_actions.ts` (and, discovered while building
 * this guard, `src/app/(admin)/novels/_actions.ts`) used to re-export a
 * handful of `@/server/**` types via a bare `export type { A, B, C };` list
 * so Client Components could name them without themselves importing
 * `@/server/...` (forbidden by `admin-secret-boundary.test.tsx`). That list
 * form does not compile away cleanly in a `"use server"` file: Next's
 * Server Actions export transform emits a runtime reference
 * (`ensureServerEntryExports([...])` / `registerServerReference(...)`) for
 * every name in the list, without checking that the name is actually a
 * type-only binding — but type-only bindings are erased by the ordinary
 * TypeScript/SWC type-stripping pass before that, so the emitted reference
 * pointed at nothing. The result: `ReferenceError: RebindBatchDetail is not
 * defined at module evaluation`, thrown the instant anything imported the
 * module — crashing every real Server Action in the same file, not just
 * the broken export (X8 web log, 35 occurrences, all under `/articles`).
 *
 * This guard parses every `"use server"` file in the repo with the
 * TypeScript compiler API (no type-checker needed — this is a pure syntax
 * shape check) and asserts each of its top-level exports is one of:
 *
 *   - `export async function NAME(...) { ... }`
 *   - `export default async function [NAME](...) { ... }`
 *   - `export const NAME = async (...) => { ... }` /
 *     `export const NAME = async function (...) { ... }`
 *   - `export type NAME = ...;` — a fresh type ALIAS DECLARATION. This is
 *     the one shape deliberately allowed despite starting with the same two
 *     keywords as the forbidden pattern below: it is a single self-contained
 *     AST node (`ts.TypeAliasDeclaration`) that vanishes entirely once
 *     erased, with no leftover bare identifier for the transform to
 *     mis-treat as a value — confirmed by building this repo before this
 *     fix and finding `PublishLifecycleErrorCode` (an alias declared this
 *     way in `novels/_actions.ts`) absent from the compiled chunk's
 *     `ensureServerEntryExports([...])` call, while `RightsTransitionResult`
 *     (re-exported via the list form one line above it) was present as a
 *     bare, undeclared identifier there.
 *
 * Every other export shape is rejected, in particular:
 *
 *   - `export type { A, B };` / `export type { A } from "mod";` — the exact
 *     shape that broke `/articles` (and `/novels`).
 *   - `export { A, B } from "mod";` / `export * from "mod";` /
 *     `export * as ns from "mod";` — the same "named export list, not a
 *     declaration" AST shape (`ts.ExportDeclaration`), forbidden
 *     unconditionally regardless of a `type` modifier, `from` clause, or
 *     wildcard form.
 *   - `export interface NAME { ... }` / `export enum NAME { ... }` /
 *     `export class NAME { ... }` — declaration-shaped, but not a Server
 *     Action; a `"use server"` file has no legitimate reason to export any
 *     of these today (none currently do — see the mutation test below for
 *     why the guard must keep catching all of them, not just one).
 *   - `export const NAME = <non-async value>;` — e.g. a plain constant or a
 *     non-async function assigned to a const.
 *
 * A file must actually have `"use server"` as its literal first statement
 * (the real directive-prologue rule Next.js itself enforces) to be scanned
 * at all — everything else in the repo, `"use client"` files included, is
 * out of scope for this guard (that boundary is `admin-secret-boundary.
 * test.tsx`'s job).
 */

const REPO_ROOT = process.cwd();
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "dist",
  "build",
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const directory = path.resolve(REPO_ROOT, root);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (SKIP_DIRECTORIES.has(entry.name)) return [];
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path.relative(REPO_ROOT, target));
      return entry.isFile() && /\.tsx?$/.test(entry.name)
        ? [path.relative(REPO_ROOT, target)]
        : [];
    }),
  );
  return nested.flat();
}

function hasLeadingUseServerDirective(sourceFile: ts.SourceFile): boolean {
  const first = sourceFile.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteralLike(first.expression) &&
    first.expression.text === "use server"
  );
}

function isAsyncFunctionLike(modifiers: readonly ts.ModifierLike[] | undefined): boolean {
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function hasModifier(modifiers: readonly ts.ModifierLike[] | undefined, kind: ts.SyntaxKind): boolean {
  return !!modifiers?.some((modifier) => modifier.kind === kind);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function checkExportedVariableStatement(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  violations: Violation[],
): void {
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer;
    const initializerModifiers =
      initializer && ts.canHaveModifiers(initializer) ? ts.getModifiers(initializer) : undefined;
    const isAsyncArrowOrFunctionExpression =
      !!initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      isAsyncFunctionLike(initializerModifiers);
    if (isAsyncArrowOrFunctionExpression) continue;
    violations.push({
      file: sourceFile.fileName,
      line: lineOf(sourceFile, declaration),
      reason: `export const "${declaration.name.getText(sourceFile)}" is not an async function — only "export const NAME = async (...) => {...}" is allowed in a "use server" file, everything else (plain values, non-async functions) is forbidden`,
    });
  }
}

export function findUseServerExportViolations(filePath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (!hasLeadingUseServerDirective(sourceFile)) return violations;

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      // export type { A, B }; / export type { A } from "mod"; /
      // export { A } from "mod"; / export * from "mod"; / export * as ns from "mod";
      // — always forbidden, regardless of the `type` modifier or a `from` clause.
      violations.push({
        file: sourceFile.fileName,
        line: lineOf(sourceFile, statement),
        reason:
          'export declaration list ("export {...}", "export type {...}", "export {...} from", or "export * from") is forbidden in a "use server" file — it can compile to a runtime reference even when every listed name is type-only. Move it into a plain module with neither "use server" nor "use client" instead.',
      });
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!hasModifier(modifiers, ts.SyntaxKind.ExportKeyword)) continue; // not exported — out of scope

    if (ts.isFunctionDeclaration(statement)) {
      if (!isAsyncFunctionLike(modifiers)) {
        violations.push({
          file: sourceFile.fileName,
          line: lineOf(sourceFile, statement),
          reason: `export function "${statement.name?.getText(sourceFile) ?? "(default)"}" must be async in a "use server" file`,
        });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      checkExportedVariableStatement(statement, sourceFile, violations);
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      // ALLOWED: a fresh `export type NAME = ...;` alias declaration erases
      // cleanly — see this file's header and `../../src/app/(admin)/articles/
      // _types/rebind.ts` for the build evidence.
      continue;
    }

    const forbiddenDeclarationKind = ts.isInterfaceDeclaration(statement)
      ? "interface"
      : ts.isEnumDeclaration(statement)
        ? "enum"
        : ts.isClassDeclaration(statement)
          ? "class"
          : undefined;
    if (forbiddenDeclarationKind) {
      violations.push({
        file: sourceFile.fileName,
        line: lineOf(sourceFile, statement),
        reason: `export ${forbiddenDeclarationKind} is forbidden in a "use server" file`,
      });
      continue;
    }

    // Any other exported top-level shape (module declarations, etc.) is
    // conservatively rejected too — a "use server" file's only job is to
    // export Server Actions (plus the one allowed type-alias shape above).
    violations.push({
      file: sourceFile.fileName,
      line: lineOf(sourceFile, statement),
      reason: `unexpected exported top-level shape (SyntaxKind ${ts.SyntaxKind[statement.kind]}) in a "use server" file`,
    });
  }

  return violations;
}

describe('"use server" files export only async actions (module-eval ReferenceError guard)', () => {
  it('never lets a "use server" file export a type re-export list, interface, enum, class, or non-async const', async () => {
    const files = await collectSourceFiles(".");
    expect(files.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const source = await readFile(path.resolve(REPO_ROOT, file), "utf8");
      violations.push(...findUseServerExportViolations(file, source));
    }

    if (violations.length > 0) {
      const message = violations.map((violation) => `${violation.file}:${violation.line} — ${violation.reason}`).join("\n");
      throw new Error(`"use server" export guard found ${violations.length} violation(s):\n${message}`);
    }
  });

  it("actually scanned at least one real \"use server\" file (guards against a silent no-op)", async () => {
    const files = await collectSourceFiles(".");
    let scanned = 0;
    for (const file of files) {
      const source = await readFile(path.resolve(REPO_ROOT, file), "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      if (hasLeadingUseServerDirective(sourceFile)) scanned += 1;
    }
    expect(scanned).toBeGreaterThan(0);
  });

  it('catches the exact bare "export type { … };" shape that broke every /articles Server Action', () => {
    const source = [
      '"use server";',
      "",
      'import { doThing, type Foo } from "@/server/x";',
      "",
      "export type { Foo };",
      "",
      "export async function bar() {",
      "  return doThing();",
      "}",
      "",
    ].join("\n");
    const violations = findUseServerExportViolations("virtual/_actions.ts", source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((violation) => violation.reason.includes("export declaration list"))).toBe(true);
  });

  it("allows a fresh type-alias declaration, an async function, and an async const action in the same file", () => {
    const source = [
      '"use server";',
      "",
      "export type Foo = { ok: true };",
      "",
      "export async function bar() {",
      "  return 1;",
      "}",
      "",
      "export const baz = async () => 2;",
      "",
    ].join("\n");
    expect(findUseServerExportViolations("virtual/_actions.ts", source)).toEqual([]);
  });
});
