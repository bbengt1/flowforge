"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { rewriteEmbedNavigationHref } from "@/lib/embed-tenancy-contract";

/**
 * Keeps in-app <a> / Link clicks on the /embed/v1 mount. Host-supplied
 * tenant/workbench query is not added. API and external hrefs pass through.
 */
export function EmbedDeepLinkGuard({ children }: { children: ReactNode }) {
  const router = useRouter();

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest("a");
    if (!target) {
      return;
    }
    const href = target.getAttribute("href");
    if (!href) {
      return;
    }
    const next = rewriteEmbedNavigationHref(href, window.location.origin);
    if (!next) {
      return;
    }
    event.preventDefault();
    router.push(next);
  }

  return <div onClick={onClick}>{children}</div>;
}
