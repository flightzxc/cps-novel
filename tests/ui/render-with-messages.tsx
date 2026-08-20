import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";

import { loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

const messages = loadMessages(PUBLIC_SITE_LOCALE);

export function renderWithMessages(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <MessagesProvider locale={PUBLIC_SITE_LOCALE} messages={messages}>
        {children}
      </MessagesProvider>
    ),
  });
}
