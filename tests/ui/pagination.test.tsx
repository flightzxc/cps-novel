import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Pagination } from "@/features/public-ui/collection/Pagination";

describe("Pagination", () => {
  it("does not render when there is only one page", () => {
    render(<Pagination currentPage={1} totalPages={1} basePath="/browse" />);
    expect(screen.queryByTestId("pagination")).toBeNull();
  });

  it("omits ?page= from the previous link when going back to page 1", () => {
    render(<Pagination currentPage={2} totalPages={3} basePath="/browse" />);

    expect(screen.getByTestId("pagination")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Previous/ }).getAttribute("href")).toBe("/browse");
    expect(screen.getByRole("link", { name: /Next/ }).getAttribute("href")).toBe("/browse?page=3");
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
  });
});
