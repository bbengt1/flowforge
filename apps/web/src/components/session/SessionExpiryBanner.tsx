"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  effectiveExpiresAt,
  formatSessionCountdown,
  sessionExpiryBannerState,
} from "@/lib/session";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_SKIP_CLASS,
} from "@/lib/settings-wizard-visual";

export function SessionExpiryBanner() {
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snapshot.active && !snapshot.stale) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.active, snapshot.stale]);

  const banner = sessionExpiryBannerState(snapshot, now);
  if (!banner.visible) {
    return null;
  }

  if (banner.kind === "stale") {
    return (
      <div
        role={banner.role}
        className={`${FF_SETTINGS_SKIP_CLASS} px-4 py-3 text-sm`}
      >
        <p className="font-medium">{banner.title}</p>
        <p className="mt-1">
          The control plane returned{" "}
          <code className="font-mono text-xs">401 unauthenticated</code>.{" "}
          <a className={FF_SETTINGS_LINK_CLASS} href="#session">
            Re-establish a cookie session
          </a>
          . Header identity is not used while a stale session is latched.
        </p>
      </div>
    );
  }

  const expiresAt = effectiveExpiresAt(snapshot.session);
  return (
    <div
      role={banner.role}
      className={`${FF_SETTINGS_SKIP_CLASS} px-4 py-3 text-sm`}
    >
      <p className="font-medium">{banner.title}</p>
      <p className="mt-1">
        {formatSessionCountdown(expiresAt, now)} (idle{" "}
        {snapshot.session.idleExpiresAt || "—"}, absolute{" "}
        {snapshot.session.absoluteExpiresAt || "—"}).{" "}
        <a className={FF_SETTINGS_LINK_CLASS} href="#session">
          Open session controls
        </a>
      </p>
    </div>
  );
}
