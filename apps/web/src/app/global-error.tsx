"use client";

import { RouteErrorPanel } from "@/components/chrome/RouteErrorPanel";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html
      lang="en"
      className={`h-full ${FF_SHELL_ROOT_CLASS}`}
      data-ff-tokens={FF_SHELL_ROOT_VALUE}
    >
      <body className="h-full min-h-full antialiased">
        <RouteErrorPanel error={error} reset={reset} />
      </body>
    </html>
  );
}
