"use client";

import { useEffect, useRef, useState } from "react";

/**
 * B-39 — Cloudflare Turnstile widget for the admin login.
 *
 * Ported from the short-drama sister site's `src/components/turnstile.tsx` (CPS
 * commit `26e2682`, see `docs/governance/port-registry.md`): same explicit-render
 * script loader (one `<script id="cf-turnstile-script">` per document, shared by
 * every mount), same render/remove lifecycle, same callbacks and load-error
 * copy. Two adaptations to this form's shape:
 *
 *   - CPS's form is a `<form action>` that reads a hidden `turnstileToken`
 *     input out of `FormData`. This login form is controlled state +
 *     `loginAction({...})`, so the widget reports the token upward through
 *     `onTokenChange` instead of owning a hidden input.
 *   - The backend is light-only (`(admin-auth)/layout.tsx`), so `theme: "light"`
 *     rather than CPS's implicit auto.
 *
 * This component is only ever mounted when the server resolved Turnstile as
 * ON and fully configured (`readAdminLoginTurnstilePublicState().state ===
 * "ready"`). With the switch off nothing here runs, so no request to
 * `challenges.cloudflare.com` is ever made.
 *
 * A Turnstile token is single use: the parent remounts this component (new
 * `key`) after every refused submission to obtain a fresh one.
 */

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LOAD_ERROR_COPY = "人机验证加载失败，请刷新页面后重试";

function loadTurnstileScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile script load failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script load failed"));
    document.head.appendChild(script);
  });
}

export function TurnstileWidget({
  siteKey,
  onTokenChange,
}: {
  siteKey: string;
  /** Receives the fresh token, or `""` once it expired or errored. */
  onTokenChange: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    let mounted = true;

    async function setupWidget() {
      if (!containerRef.current) return;

      try {
        await loadTurnstileScript();

        if (!mounted || !containerRef.current || !window.turnstile) return;

        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        containerRef.current.innerHTML = "";
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (nextToken) => {
            onTokenChangeRef.current(nextToken);
            setLoadError("");
          },
          "expired-callback": () => {
            onTokenChangeRef.current("");
          },
          "error-callback": () => {
            onTokenChangeRef.current("");
            setLoadError(LOAD_ERROR_COPY);
          },
        });
      } catch {
        if (mounted) setLoadError(LOAD_ERROR_COPY);
      }
    }

    void setupWidget();

    return () => {
      mounted = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  return (
    <div className="space-y-2">
      <div ref={containerRef} />
      {loadError ? (
        <p role="alert" className="text-sm text-red-700">
          {loadError}
        </p>
      ) : null}
    </div>
  );
}
