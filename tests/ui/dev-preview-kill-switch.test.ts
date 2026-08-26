import "./setup-cleanup";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadLayout() {
  vi.resetModules();
  return import("@/app/dev-preview/layout");
}

function expectNotFound(render: () => unknown) {
  try {
    render();
    throw new Error("expected notFound()");
  } catch (error) {
    expect(error).toBe(NOT_FOUND);
  }
}

describe("dev-preview kill switch", () => {
  it("renders the mock shell when DEV_PREVIEW_ENABLED is true", async () => {
    vi.stubEnv("DEV_PREVIEW_ENABLED", "true");
    const { default: DevPreviewLayout } = await loadLayout();
    const tree = DevPreviewLayout({ children: "PREVIEW" }) as {
      props: { "data-mock-only"?: string; children: unknown };
    };
    expect(tree.props["data-mock-only"]).toBe("true");
    expect(tree.props.children).toBeTruthy();
  });

  it("calls notFound when the env is unset", async () => {
    vi.stubEnv("DEV_PREVIEW_ENABLED", "");
    delete process.env.DEV_PREVIEW_ENABLED;
    const { default: DevPreviewLayout } = await loadLayout();
    expectNotFound(() => DevPreviewLayout({ children: "PREVIEW" }));
  });

  it("calls notFound when the env is any value other than true", async () => {
    vi.stubEnv("DEV_PREVIEW_ENABLED", "false");
    const { default: DevPreviewLayout } = await loadLayout();
    expectNotFound(() => DevPreviewLayout({ children: "PREVIEW" }));
  });
});
