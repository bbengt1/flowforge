"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  effectiveExpiresAt,
  sessionExpiryState,
  sessionStatusChipAccessibleName,
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
  const accessibleName = sessionStatusChipAccessibleName(snapshot, now);
  if (snapshot.stale) {
    return (
      <a
        href={sessionHref}
        aria-label={accessibleName}
        className="ff-shell-chip-danger rounded-full px-2.5 py-0.5 text-xs font-medium"
      >
        {label}
      </a>
    );
  }

  if (!snapshot.active) {
    return (
      <a
        href={sessionHref}
        aria-label={accessibleName}
        className="ff-shell-chip rounded-full px-2.5 py-0.5 text-xs"
      >
        {label}
      </a>
    );
  }

  const expiresAt = effectiveExpiresAt(snapshot.session);
  const state = sessionExpiryState(expiresAt, now);
  const tone =
    state === "expired" || state === "warning"
      ? "ff-shell-chip-danger"
      : "ff-shell-chip-accent";

  return (
    <a
      href={sessionHref}
      aria-label={accessibleName}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
      title={snapshot.session.subject}
    >
      {label}
    </a>
  );
}
