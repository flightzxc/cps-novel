import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";

function panel(props: Partial<Parameters<typeof PublicStatusPanel>[0]> = {}) {
  return render(
    <PublicStatusPanel title="Title" body="Body" homeLabel="Back to home" {...props} />,
  );
}

describe("PublicStatusPanel", () => {
  /**
   * `min-h-[46vh]` is sized for a panel framed by a header and a footer. On a
   * bare full-viewport page it would leave the lower half of the screen empty,
   * so bare centres on the viewport instead.
   */
  it("centres on the viewport when bare instead of reusing the in-shell height", () => {
    const { container } = panel({ bare: true });
    const wrapper = container.firstElementChild as HTMLElement;

    expect(wrapper.className).toContain("min-h-screen");
    expect(wrapper.className).toContain("justify-center");
    expect(container.innerHTML).not.toContain("min-h-[46vh]");
  });

  it("keeps the in-shell height when it is not bare", () => {
    const { container } = panel();
    expect(container.innerHTML).toContain("min-h-[46vh]");
    expect(container.innerHTML).not.toContain("min-h-screen");
  });

  it("renders no retry action unless one is supplied", () => {
    panel();
    expect(screen.queryByRole("button")).toBeNull();
  });

  /** Retry is the paper action; going home stays the outline one. */
  it("gives retry the accent variant and home the outline variant", () => {
    panel({ bare: true, retryLabel: "Try again", onRetry: () => undefined });

    expect(screen.getByRole("button", { name: "Try again" }).className).toContain(
      "bg-novel-accent",
    );
    expect(screen.getByRole("link", { name: "Back to home" }).className).toContain(
      "border-novel-border-strong",
    );
  });
});

describe("AdminTimeZoneNote", () => {
  it("declares the zone once so values can stay bare", () => {
    render(<AdminTimeZoneNote />);
    expect(screen.getByTestId("admin-time-zone-note").textContent).toContain("UTC+8");
  });
});
