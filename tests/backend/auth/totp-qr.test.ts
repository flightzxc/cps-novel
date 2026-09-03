import { describe, expect, it, vi } from "vitest";

/**
 * RC-11 — `createTotpQrCodeDataUrl` (`@/lib/auth/totp.ts`), the one addition
 * this repo's TOTP module gets for the QR enrollment flow. Two angles:
 * exact CPS-parity call parameters (mocked `qrcode`, so this test does not
 * depend on the real PNG bytes), and a real-library smoke test proving the
 * output is an actual `data:image/png;base64,...` PNG, not just a string
 * shaped like one.
 */

describe("createTotpQrCodeDataUrl — CPS-parity call parameters (mocked qrcode)", () => {
  it("calls QRCode.toDataURL with the exact CPS parameters and the given URI, unmodified", async () => {
    const toDataURL = vi.fn().mockResolvedValue("data:image/png;base64,MOCKED");
    vi.doMock("qrcode", () => ({ toDataURL }));
    vi.resetModules();
    const { createTotpQrCodeDataUrl } = await import("@/lib/auth/totp");

    const uri = "otpauth://totp/root%40cps-novel?secret=JBSWY3DPEHPK3PXP&issuer=cps-novel";
    const result = await createTotpQrCodeDataUrl(uri);

    expect(toDataURL).toHaveBeenCalledWith(uri, { errorCorrectionLevel: "M", margin: 1, width: 256 });
    expect(result).toBe("data:image/png;base64,MOCKED");

    vi.doUnmock("qrcode");
    vi.resetModules();
  });
});

describe("createTotpQrCodeDataUrl — real qrcode library", () => {
  it("renders the otpauth URI as an actual PNG data URL", async () => {
    const { createTotpQrCodeDataUrl, createTotpUri } = await import("@/lib/auth/totp");
    const uri = createTotpUri("owner", "JBSWY3DPEHPK3PXP");

    const dataUrl = await createTotpQrCodeDataUrl(uri);

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("encodes different secrets into different images (not a static placeholder)", async () => {
    const { createTotpQrCodeDataUrl, createTotpUri } = await import("@/lib/auth/totp");
    const a = await createTotpQrCodeDataUrl(createTotpUri("owner", "AAAAAAAAAAAAAAAA"));
    const b = await createTotpQrCodeDataUrl(createTotpUri("owner", "ZZZZZZZZZZZZZZZZ"));
    expect(a).not.toBe(b);
  });
});
