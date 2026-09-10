"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  effectiveExpiresAt,
  sessionExpiryState,
  sessionStatusChipLabel,
} from "@/lib/session";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";
import { loadCurrentSession } from "@/lib/session-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function SessionStatusChip() {
  const pathname = usePathname();
  const embed = useEmbedMode();
  const settingsHref = embed ? embedDeepLink("/settings") : "/settings";
  const membershipHref = embed ? embedDeepLink("/membership") : "/membership";
  const isolationHref = embed ? embedDeepLink("/isolation") : "/isolation";
  const sessionHref =
    pathname === settingsHref ||
    pathname === membershipHref ||
    pathname === isolationHref
      ? "#session"
      : `${settingsHref}#session`;
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void loadCurrentSession();
  }, []);

  useEffect(() => {
    if (!snapshot.active) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.active]);

  const label = sessionStatusChipLabel(snapshot, now);
  if (snapshot.stale) {
    return (
      <a
        href={sessionHref}
        className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900"
      >
        {label}
      </a>
    );
  }

  if (!snapshot.active) {
    return (
      <a
        href={sessionHref}
        className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-600"
      >
        {label}
      </a>
    );
  }

  const expiresAt = effectiveExpiresAt(snapshot.session);
  const state = sessionExpiryState(expiresAt, now);
  const tone =
    state === "expired" || state === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-teal-200 bg-teal-50 text-teal-900";

  return (
    <a
      href={sessionHref}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
      title={snapshot.session.subject}
    >
      {label}
    </a>
  );
}
