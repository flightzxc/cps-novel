import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createLaneBReadClient,
  prepareLaneBOwnerCredential,
  readOwnerJwtOnce,
} from "../../../scripts/p2-06-5-lane-b/http-client.mjs";

const repoRoot = resolve(process.cwd());

async function ownerOnlyCredential(value = "test.jwt.value") {
  const directory = await mkdtemp(join(tmpdir(), "lane-b-credential-"));
  const path = join(directory, "jwt");
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return { directory, path, value };
}

describe("P2-06.5 Lane B read-only HTTP boundary", () => {
  it("reads a regular owner-only credential outside the repository", async () => {
    const fixture = await ownerOnlyCredential();
    await expect(readOwnerJwtOnce({ credentialFile: fixture.path, repoRoot })).resolves.toBe(fixture.value);
  });

  it("passes a prevalidated credential through an opaque single-use capsule", async () => {
    const fixture = await ownerOnlyCredential();
    const capsule = await prepareLaneBOwnerCredential({ credentialFile: fixture.path, repoRoot });
    expect(JSON.stringify(capsule)).toBe("{}");
    expect(Reflect.ownKeys(capsule)).toEqual([]);
    const client = await createLaneBReadClient({
      credentialCapsule: capsule,
      repoRoot,
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fixture.value}`);
        return new Response(JSON.stringify({ data: { totalCount: 0, list: [] } }), { status: 200 });
      },
    });
    await expect(client.requestPage(1)).resolves.toMatchObject({ ok: true });
    await expect(createLaneBReadClient({
      credentialCapsule: capsule,
      repoRoot,
      fetchImpl: async () => new Response("{}"),
    })).rejects.toMatchObject({ code: "credential_capsule_invalid_or_consumed" });
  });

  it("rejects credentials inside the repository and group/world-readable files", async () => {
    const inside = join(repoRoot, ".tmp-lane-b-test-jwt");
    await writeFile(inside, "test.jwt.value", { encoding: "utf8", mode: 0o600 });
    try {
      await expect(readOwnerJwtOnce({ credentialFile: inside, repoRoot })).rejects.toMatchObject({
        code: "credential_file_must_be_outside_repository",
      });
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(inside);
    }

    const unsafe = await ownerOnlyCredential();
    await chmod(unsafe.path, 0o640);
    await expect(readOwnerJwtOnce({ credentialFile: unsafe.path, repoRoot })).rejects.toMatchObject({
      code: "credential_file_permissions_must_be_owner_only",
    });
  });

  it("can call only the fixed endpoint with the fixed five-field body and spaces starts by one second", async () => {
    const fixture = await ownerOnlyCredential();
    let clock = 10_000;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      starts.push(clock);
      expect(String(url)).toBe("https://kocserver-cn.cdreader.com/api/v1/res/getlistpc");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "",
        orderType: 1,
        pageIndex: starts.length,
        pageSize: 100,
        projectType: 1,
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fixture.value}`);
      return new Response(JSON.stringify({ data: { totalCount: 1000, list: [] } }), { status: 200 });
    });
    const client = await createLaneBReadClient({
      credentialFile: fixture.path,
      repoRoot,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => clock,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
    });
    await client.requestPage(1);
    await client.requestPage(2);
    expect(starts).toEqual([10_000, 11_000]);
  });

  it("rechecks the clock when a timer wakes one millisecond early", async () => {
    const fixture = await ownerOnlyCredential();
    let clock = 20_000;
    const starts: number[] = [];
    let sleepCalls = 0;
    const client = await createLaneBReadClient({
      credentialFile: fixture.path,
      repoRoot,
      fetchImpl: (async () => {
        starts.push(clock);
        return new Response(JSON.stringify({ data: { totalCount: 0, list: [] } }), { status: 200 });
      }) as typeof fetch,
      now: () => clock,
      sleep: async (milliseconds: number) => {
        sleepCalls += 1;
        clock += sleepCalls === 1 ? milliseconds - 1 : milliseconds;
      },
    });
    await client.requestPage(1);
    await client.requestPage(2);
    expect(starts).toEqual([20_000, 21_000]);
    expect(sleepCalls).toBe(2);
  });

  it("never returns the Authorization value and fails closed if upstream reflects it", async () => {
    const fixture = await ownerOnlyCredential();
    const client = await createLaneBReadClient({
      credentialFile: fixture.path,
      repoRoot,
      fetchImpl: async () => new Response(JSON.stringify({ echoed: fixture.value }), { status: 200 }),
    });
    await expect(client.requestPage(1)).rejects.toEqual(expect.objectContaining({
      code: "credential_reflected_by_upstream",
    }));
  });

  it("detects a credential reflected through decoded JSON escapes before persistence", async () => {
    const fixture = await ownerOnlyCredential("header.payload.signature");
    const escaped = fixture.value.replaceAll(".", "\\u002e");
    const client = await createLaneBReadClient({
      credentialFile: fixture.path,
      repoRoot,
      fetchImpl: async () => new Response(`{"data":{"description":"${escaped}"}}`, { status: 200 }),
    });
    await expect(client.requestPage(1)).rejects.toEqual(expect.objectContaining({
      code: "credential_reflected_by_upstream",
    }));
  });

  it("rejects malformed credential locations without exposing them in error text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lane-b-missing-"));
    await mkdir(join(directory, "not-a-file"));
    await expect(readOwnerJwtOnce({ credentialFile: join(directory, "not-a-file"), repoRoot }))
      .rejects.toThrow("credential_path_is_not_regular_file");
  });
});
