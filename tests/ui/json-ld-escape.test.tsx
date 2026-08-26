import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { JsonLd, escapeJsonLd } from "@/app/_components/json-ld";

describe("escapeJsonLd", () => {
  it("leaves JSON without < unchanged", () => {
    const json = JSON.stringify({ name: "Lantern" });
    expect(escapeJsonLd(json)).toBe(json);
  });

  it("replaces < so </script> cannot appear in the payload", () => {
    const json = JSON.stringify({ name: "</script><img src=x>" });
    const escaped = escapeJsonLd(json);
    expect(escaped).not.toContain("</script>");
    expect(escaped).toContain("\\u003c");
  });
});

describe("JsonLd render", () => {
  it("keeps a safe title in the script body", () => {
    const json = JSON.stringify({ name: "Lantern" });
    const { container } = render(<JsonLd json={json} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).toContain("Lantern");
    expect(script?.innerHTML).not.toContain("\\u003c");
  });

  it("does not put a raw </script> sequence into the script body", () => {
    const json = JSON.stringify({ name: "</script><img src=x onerror=alert(1)>" });
    const { container } = render(<JsonLd json={json} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).toContain("\\u003c");
    expect(script?.innerHTML).not.toContain("</script>");
  });
});
