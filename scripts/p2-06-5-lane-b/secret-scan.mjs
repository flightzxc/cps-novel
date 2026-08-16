import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SECRET_PATTERNS = Object.freeze([
  { code: "authorization_bearer", regex: /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]+/giu },
  { code: "jwt_compact", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  // `token` is a legitimate upstream taxonomy/data key; flag only explicit
  // credential-bearing names here. Exact Owner values are scanned separately.
  { code: "credential_assignment", regex: /["']?\b(?:jwt|secret|credential|api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token)\b["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/giu },
]);

async function filesUnder(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Secret scan refuses symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("Secret scan root must be a directory");
  await visit(root);
  return output.sort();
}

/** @param {string} root @param {{forbiddenValues?:string[]}} [options] */
export async function scanLaneBArtifactsForSecrets(root, { forbiddenValues = [] } = {}) {
  const findings = [];
  const exactForbidden = forbiddenValues.filter((value) => typeof value === "string" && value.length > 0);
  for (const file of await filesUnder(root)) {
    const content = await readFile(file, "utf8");
    for (const { code, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) findings.push({ path: relative(root, file), code });
    }
    for (const value of exactForbidden) {
      if (content.includes(value)) findings.push({ path: relative(root, file), code: "forbidden_exact_value" });
    }
  }
  return { ok: findings.length === 0, findings };
}
