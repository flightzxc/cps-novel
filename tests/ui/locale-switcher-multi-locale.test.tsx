import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { renderWithMessages } from "./render-with-messages";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3): `LocaleSwitcher`
 * behavior once more than one locale is open. This is a hypothetical state
 * this round never actually reaches in production (`listPublishableLocales()`
 * stays `["en"]`), so `listPublishableLocales` is mocked here to prove the
 * component's rendering/interaction logic independent of the codebase's
 * current open-set size — separate file from `locale-switcher.test.tsx`
 * because `vi.mock` is hoisted file-wide and would otherwise also apply to
 * that file's "renders nothing against the REAL open set" assertion.
 */
vi.mock("@/lib/locale/locale-canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/locale-canonical")>();
  return { ...actual, listPublishableLocales: () => ["en", "es"] };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/browse" }));

const { LocaleSwitcher } = await import("@/features/public-ui/layout/LocaleSwitcher");

describe("LocaleSwitcher — with more than one locale open", () => {
  it("renders a trigger button labelled with the current locale's native name and Language aria-label", () => {
    renderWithMessages(<LocaleSwitcher />);
    const trigger = screen.getByRole("button", { name: "Language" });
    expect(within(trigger).getByText("English")).toBeTruthy();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a role=menu with a menuitem per open locale, aria-current on the active one, and correct prefixed hrefs", () => {
    renderWithMessages(<LocaleSwitcher />);

    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.getAttribute("id"));

    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);

    const en = within(menu).getByRole("menuitem", { name: "English" });
    expect(en.getAttribute("aria-current")).toBe("true");
    expect(en.getAttribute("href")).toBe("/browse");

    const es = within(menu).getByRole("menuitem", { name: "Español" });
    expect(es.getAttribute("aria-current")).toBeNull();
    expect(es.getAttribute("href")).toBe("/es/browse");
  });

  it("Esc closes the menu and returns focus to the trigger", () => {
    renderWithMessages(<LocaleSwitcher />);

    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when clicking outside the switcher", () => {
    renderWithMessages(
      <div>
        <LocaleSwitcher />
        <p data-testid="outside">outside</p>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when a menuitem is clicked", () => {
    renderWithMessages(<LocaleSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    const es = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Español" });
    // Prevent the real navigation jsdom would otherwise attempt (and log as
    // "Not implemented: navigation") — matches `tests/ui/site-header.test.tsx`'s
    // identical suppression for its own real `<a href>` click.
    es.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(es);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
