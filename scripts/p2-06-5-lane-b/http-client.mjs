import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  LANE_B_ENDPOINT,
  MIN_REQUEST_START_INTERVAL_MS,
  buildLaneBRequestBody,
} from "./constants.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
// The token is deliberately kept out of the capsule object itself. A capsule
// can be passed across the CLI -> sampler boundary without becoming printable,
// serializable, or reusable after the HTTP client consumes it.
const OWNER_CREDENTIAL_CAPSULES = new WeakMap();

export class LaneBSafetyError extends Error {
  constructor(code) {
    super(`Lane B safety check failed: ${code}`);
    this.name = "LaneBSafetyError";
    this.code = code;
  }
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

/**
 * Reads the JWT exactly once from an Owner-provided file outside the repository.
 * The returned value must remain in memory only and must never be logged or
 * serialized by callers.
 */
export async function readOwnerJwtOnce({ credentialFile, repoRoot }) {
  if (typeof credentialFile !== "string" || credentialFile.length === 0) {
    throw new LaneBSafetyError("credential_file_required");
  }

  const requestedPath = resolve(credentialFile);
  const repositoryPath = await realpath(resolve(repoRoot));
  let linkInfo;
  try {
    linkInfo = await lstat(requestedPath);
  } catch {
    throw new LaneBSafetyError("credential_file_unreadable");
  }
  if (linkInfo.isSymbolicLink()) {
    throw new LaneBSafetyError("credential_file_symlink_rejected");
  }

  let credentialPath;
  let fileInfo;
  try {
    credentialPath = await realpath(requestedPath);
    fileInfo = await stat(credentialPath);
  } catch {
    throw new LaneBSafetyError("credential_file_unreadable");
  }
  if (isInside(repositoryPath, credentialPath)) {
    throw new LaneBSafetyError("credential_file_must_be_outside_repository");
  }
  if (!fileInfo.isFile()) {
    throw new LaneBSafetyError("credential_path_is_not_regular_file");
  }
  if (fileInfo.size < 1 || fileInfo.size > MAX_CREDENTIAL_BYTES) {
    throw new LaneBSafetyError("credential_file_size_invalid");
  }
  if (process.platform !== "win32") {
    if ((fileInfo.mode & 0o077) !== 0) {
      throw new LaneBSafetyError("credential_file_permissions_must_be_owner_only");
    }
    if (typeof process.getuid === "function" && fileInfo.uid !== process.getuid()) {
      throw new LaneBSafetyError("credential_file_owner_mismatch");
    }
  }

  let raw;
  try {
    raw = await readFile(credentialPath, "utf8");
  } catch {
    throw new LaneBSafetyError("credential_file_unreadable");
  }
  const token = raw.trim();
  raw = "";
  if (!token || token.includes("\n") || token.includes("\r")) {
    throw new LaneBSafetyError("credential_file_must_contain_one_token");
  }
  return token;
}

/**
 * Read and validate the Owner credential before any create-only run directory
 * is allocated. The returned value is opaque and may be consumed exactly once
 * by createLaneBReadClient.
 */
export async function prepareLaneBOwnerCredential({ credentialFile, repoRoot }) {
  const token = await readOwnerJwtOnce({ credentialFile, repoRoot });
  const capsule = Object.freeze(Object.create(null));
  OWNER_CREDENTIAL_CAPSULES.set(capsule, token);
  return capsule;
}

/** Drop an unconsumed capsule, for example when create-only store setup fails. */
export function discardLaneBOwnerCredential(capsule) {
  if (capsule && typeof capsule === "object") OWNER_CREDENTIAL_CAPSULES.delete(capsule);
}

function consumeLaneBOwnerCredential(capsule) {
  if (!capsule || typeof capsule !== "object" || !OWNER_CREDENTIAL_CAPSULES.has(capsule)) {
    throw new LaneBSafetyError("credential_capsule_invalid_or_consumed");
  }
  const token = OWNER_CREDENTIAL_CAPSULES.get(capsule);
  OWNER_CREDENTIAL_CAPSULES.delete(capsule);
  return token;
}

function composeTimeout(timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => clearTimeout(timer),
  };
}

function parseJsonWithoutLeaking(text) {
  try {
    return { parsed: JSON.parse(text), errorCode: null };
  } catch {
    return { parsed: null, errorCode: "malformed_json" };
  }
}

export function rawResponseContainsCredential(rawText, token) {
  if (rawText.includes(token) || rawText.includes(`Bearer ${token}`)) return true;
  try {
    const decoded = JSON.parse(rawText);
    const contains = (value) => {
      if (typeof value === "string") return value.includes(token) || value.includes(`Bearer ${token}`);
      if (Array.isArray(value)) return value.some(contains);
      if (value && typeof value === "object") {
        return Object.entries(value).some(([key, nested]) => contains(key) || contains(nested));
      }
      return false;
    };
    return contains(decoded);
  } catch {
    // A response may encode secret characters even when its JSON is malformed;
    // conservatively decode JSON escape sequences before allowing persistence.
    const unescaped = rawText.replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    return unescaped.includes(token) || unescaped.includes(`Bearer ${token}`);
  }
}

/**
 * Creates a client that can call one fixed read endpoint only. It deliberately
 * exposes no generic URL or request-body escape hatch.
 * @param {{credentialFile?:string, credentialCapsule?:object, repoRoot:string, fetchImpl?:typeof fetch, sleep?:(milliseconds:number)=>Promise<void>, now?:()=>number, timeoutMs?:number}} [options]
 */
export async function createLaneBReadClient({
  credentialFile,
  credentialCapsule,
  repoRoot,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new LaneBSafetyError("fetch_implementation_required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new LaneBSafetyError("timeout_invalid");
  if ((credentialFile === undefined) === (credentialCapsule === undefined)) {
    throw new LaneBSafetyError("exactly_one_credential_source_required");
  }

  let token = credentialCapsule === undefined
    ? await readOwnerJwtOnce({ credentialFile, repoRoot })
    : consumeLaneBOwnerCredential(credentialCapsule);
  let previousStartMs = null;

  async function requestPage(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) {
      throw new LaneBSafetyError("page_index_invalid");
    }
    if (previousStartMs !== null) {
      // Timers may wake a millisecond early. Re-check the measured clock after
      // every wake so the persisted request-start facts can never be 999ms
      // apart when the frozen contract requires at least 1000ms.
      let elapsed = now() - previousStartMs;
      while (elapsed < MIN_REQUEST_START_INTERVAL_MS) {
        await sleep(Math.max(1, MIN_REQUEST_START_INTERVAL_MS - elapsed));
        elapsed = now() - previousStartMs;
      }
    }
    const startedAtMs = now();
    previousStartMs = startedAtMs;
    const scoped = composeTimeout(timeoutMs);
    const timing = () => {
      const finishedAtMs = now();
      return {
        startedAtMs,
        finishedAtMs,
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
      };
    };
    try {
      const response = await fetchImpl(LANE_B_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildLaneBRequestBody(pageIndex)),
        signal: scoped.signal,
      });
      let rawText;
      try {
        rawText = await response.text();
      } catch {
        return {
          ok: false,
          pageIndex,
          status: response.status,
          rawText: null,
          parsed: null,
          errorCode: "response_body_unreadable",
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          ...timing(),
        };
      }
      if (rawResponseContainsCredential(rawText, token)) {
        throw new LaneBSafetyError("credential_reflected_by_upstream");
      }
      if (!response.ok) {
        return {
          ok: false,
          pageIndex,
          status: response.status,
          rawText,
          parsed: null,
          errorCode: "upstream_http_error",
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          ...timing(),
        };
      }
      const decoded = parseJsonWithoutLeaking(rawText);
      if (decoded.errorCode) {
        return {
          ok: false,
          pageIndex,
          status: response.status,
          rawText,
          parsed: null,
          errorCode: decoded.errorCode,
          retryable: false,
          ...timing(),
        };
      }
      return {
        ok: true,
        pageIndex,
        status: response.status,
        rawText,
        parsed: decoded.parsed,
        errorCode: null,
        retryable: false,
        ...timing(),
      };
    } catch (error) {
      if (error instanceof LaneBSafetyError) {
        Object.assign(error, timing());
        throw error;
      }
      return {
        ok: false,
        pageIndex,
        status: null,
        rawText: null,
        parsed: null,
        errorCode: scoped.timedOut() ? "request_timeout" : "transport_error",
        retryable: true,
        ...timing(),
      };
    } finally {
      scoped.cleanup();
    }
  }

  function scanArtifactText(rawText) {
    if (typeof rawText !== "string") throw new LaneBSafetyError("artifact_text_must_be_string");
    if (rawResponseContainsCredential(rawText, token)) {
      throw new LaneBSafetyError("credential_found_in_artifact");
    }
    return true;
  }

  return Object.freeze({
    requestPage,
    scanArtifactText,
    /** Replace the in-memory secret with an inert value as soon as sampling ends. */
    dispose() {
      token = "[disposed]";
      previousStartMs = null;
    },
  });
}
