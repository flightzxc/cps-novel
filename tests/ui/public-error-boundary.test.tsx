import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import ErrorPage from "@/app/error";
import GlobalErrorPage from "@/app/global-error";
import NotFoundPage from "@/app/not-found";

const HOME = "Back to home";

function assertHeadlessHome() {
  expect(screen.getByRole("link", { name: HOME }).getAttribute("href")).toBe("/");
  expect(screen.queryByTestId("site-header")).toBeNull();
}

describe("root error.tsx", () => {
  it("renders short copy, a home link, and no site chrome", () => {
    const error = Object.assign(new Error("driver secret must not leak"), { digest: "abc123" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorPage error={error} reset={() => undefined} />);

    expect(screen.getByTestId("public-error-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.queryByText("driver secret must not leak")).toBeNull();
    assertHeadlessHome();
    spy.mockRestore();
  });

  it("logs the error on mount", () => {
    const error = Object.assign(new Error("logged"), { digest: "d1" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ErrorPage error={error} reset={() => undefined} />);

    expect(spy).toHaveBeenCalledWith(error);
    spy.mockRestore();
  });
});

describe("root global-error.tsx", () => {
  it("renders short copy, a home link, and no site chrome", () => {
    const error = Object.assign(new Error("layout failed"), { digest: "g1" });
    render(<GlobalErrorPage error={error} reset={() => undefined} />);

    expect(screen.getByTestId("public-global-error-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.queryByText("layout failed")).toBeNull();
    assertHeadlessHome();
  });
});

describe("root not-found.tsx", () => {
  it("renders short copy, a home link, and no site chrome", () => {
    render(<NotFoundPage />);

    expect(screen.getByTestId("public-not-found-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This page could not be found" })).toBeTruthy();
    assertHeadlessHome();
  });
});
