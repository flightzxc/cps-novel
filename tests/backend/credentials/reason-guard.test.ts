import { describe, expect, it } from "vitest";

import { CredentialLifecycleError } from "@/lib/credentials/lifecycle";
import { assertReasonFreeOfCredentialMaterial, findJwtLikeToken } from "@/lib/credentials/reason-guard";

/**
 * D-2 regression: the credential-material guard on the operation `reason`
 * field previously flagged any bare "word.word.word" text as JWT-shaped,
 * which 100% false-positived on semver strings like "v0.2.0" or "1.2.3"
 * during credential rotation — operators could not explain a rotation by
 * referencing a release version. See P0 batch-0 work order S3.
 */

function fakeJwt(): string {
  // Three dot-separated base64url segments, structurally JWT-shaped, but not
  // a real credential — synthesized locally for the test, never a live secret.
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-subject", iat: 1 })).toString("base64url");
  const signature = Buffer.from("deterministic-test-signature-bytes").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("credential reason guard", () => {
  describe("semver strings are not flagged as JWT-like (D-2 regression)", () => {
    it.each([
      "v0.2.0",
      "1.2.3",
      "2.0.0-rc.1",
      "2.0.0+build.123",
      "v1.0.0-alpha.1+build.7",
    ])("findJwtLikeToken returns null for bare semver %s", (version) => {
      expect(findJwtLikeToken(version)).toBeNull();
    });

    it.each([
      "Rotating credential after upgrading to v0.2.0",
      "release 1.2.3 rollout notes",
      "bump to 2.0.0-rc.1 build for canary",
      "aligning with 2.0.0+build.123 deploy",
    ])("findJwtLikeToken returns null when semver is embedded in prose: %s", (reasonText) => {
      expect(findJwtLikeToken(reasonText)).toBeNull();
    });

    it.each([
      "v0.2.0",
      "1.2.3",
      "2.0.0-rc.1",
      "Owner-approved rotation aligned with release v0.2.0",
    ])("assertReasonFreeOfCredentialMaterial does not throw for %s", (reasonText) => {
      expect(() => assertReasonFreeOfCredentialMaterial(reasonText, "unrelated-secret-value")).not.toThrow();
    });
  });

  describe("real JWT-shaped material is still rejected", () => {
    it("findJwtLikeToken detects a bare fake JWT", () => {
      const jwt = fakeJwt();
      expect(findJwtLikeToken(jwt)).toBe(jwt);
    });

    it("findJwtLikeToken detects a JWT embedded in prose, including after a Bearer prefix", () => {
      const jwt = fakeJwt();
      expect(findJwtLikeToken(`Bearer ${jwt} rotation`)).toBe(jwt);
      expect(findJwtLikeToken(`reset with token ${jwt} please`)).toBe(jwt);
    });

    it("assertReasonFreeOfCredentialMaterial throws credential_validation_failed for a JWT-shaped reason", () => {
      const jwt = fakeJwt();
      expect(() => assertReasonFreeOfCredentialMaterial(jwt, "unrelated-secret-value")).toThrowError(
        expect.objectContaining({ code: "credential_validation_failed" }),
      );
    });

    it("assertReasonFreeOfCredentialMaterial throws when the reason echoes the submitted secret verbatim", () => {
      const secret = fakeJwt();
      expect(() => assertReasonFreeOfCredentialMaterial(`rotating because ${secret} expired`, secret)).toThrowError(
        expect.objectContaining({ code: "credential_validation_failed" }),
      );
    });

    it("does not regress on a non-JWT foreign-secret reason still matching submitted secret", () => {
      // Any exact-substring match of the current request's secret must still be caught,
      // independent of whether it happens to be JWT-shaped.
      const secret = "just-a-long-opaque-token-value-without-dots";
      expect(() => assertReasonFreeOfCredentialMaterial(`copied from ${secret} by mistake`, secret)).toThrowError(
        expect.objectContaining({ code: "credential_validation_failed" }),
      );
    });
  });

  describe("error message names the matched pattern instead of a generic message", () => {
    it("names the JWT-like-structure pattern", () => {
      const jwt = fakeJwt();
      try {
        assertReasonFreeOfCredentialMaterial(jwt, "unrelated-secret-value");
        throw new Error("expected assertReasonFreeOfCredentialMaterial to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialLifecycleError);
        expect((error as CredentialLifecycleError).message).toMatchInlineSnapshot(
          `"The operation reason must not contain credential material: value matches JWT-like structure (three dot-separated base64url segments)"`,
        );
      }
    });

    it("names the submitted-secret pattern", () => {
      const secret = "the-exact-secret-for-this-request";
      try {
        assertReasonFreeOfCredentialMaterial(`reason contains ${secret} verbatim`, secret);
        throw new Error("expected assertReasonFreeOfCredentialMaterial to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialLifecycleError);
        expect((error as CredentialLifecycleError).message).toMatchInlineSnapshot(
          `"The operation reason must not contain credential material: value matches the submitted credential secret"`,
        );
      }
    });
  });
});
