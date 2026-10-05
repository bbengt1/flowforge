"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { afterLocalLoginHref } from "@/lib/change-password";
import { LOGIN_SUCCESS_HREF } from "@/lib/local-login";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function SetPasswordLanding() {
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const nextHref = snapshot.active
    ? afterLocalLoginHref(snapshot.session.mustChangePassword === true)
    : null;

  useEffect(() => {
    if (snapshot.active && nextHref) {
      router.replace(nextHref);
    }
  }, [nextHref, router, snapshot.active]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16 outline-none"
    >
      <p role="status" className="text-sm" style={{ color: "var(--ff-muted)" }}>
        {!snapshot.active
          ? "Set the admin password to continue."
          : nextHref === LOGIN_SUCCESS_HREF
            ? "Opening workflows…"
            : "Opening change password…"}
      </p>
    </main>
  );
}
