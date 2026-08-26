import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ErrorPreviewPage from "@/app/dev-preview/status/error/page";
import GlobalErrorPreviewPage from "@/app/dev-preview/status/global-error/page";
import NotFoundPreviewPage from "@/app/dev-preview/status/not-found/page";
import ErrorPage from "@/app/error";
import GlobalErrorPage from "@/app/global-error";
import NotFoundPage from "@/app/not-found";

const HOME = "Back to home";
const RETRY = "Try again";
const ERROR_TITLE = "Something went wrong";
const NOT_FOUND_TITLE = "This page could not be found";

describe("dev-preview status exhibits share the real error/404 components", () => {
  it("error preview matches root error.tsx copy and testId, with a no-op retry", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorPreviewPage />);
    expect(screen.getByTestId("public-error-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: ERROR_TITLE })).toBeTruthy();
    expect(screen.getByRole("link", { name: HOME }).getAttribute("href")).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: RETRY }));
    expect(spy).not.toHaveBeenCalled();

    render(<ErrorPage error={new Error("driver secret")} reset={() => undefined} />);
    expect(screen.getAllByTestId("public-error-panel")).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: ERROR_TITLE })).toHaveLength(2);
    spy.mockRestore();
  });

  it("not-found preview matches root not-found.tsx copy and testId, with no retry", () => {
    render(<NotFoundPreviewPage />);
    expect(screen.getByTestId("public-not-found-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: NOT_FOUND_TITLE })).toBeTruthy();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();

    render(<NotFoundPage />);
    expect(screen.getAllByTestId("public-not-found-panel")).toHaveLength(2);
  });

  it("global-error preview reuses the error panel testId the real boundary uses", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<GlobalErrorPreviewPage />);
    expect(screen.getByTestId("public-global-error-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: ERROR_TITLE })).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();

    render(<GlobalErrorPage error={new Error("layout failed")} reset={() => undefined} />);
    expect(screen.getAllByTestId("public-global-error-panel")).toHaveLength(2);
    spy.mockRestore();
  });
});
