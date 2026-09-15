"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { CHANGE_PASSWORD_SUCCESS_HREF } from "@/lib/change-password";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function ChangePasswordLanding() {
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const mustChange = snapshot.session.mustChangePassword === true;

  useEffect(() => {
    if (snapshot.active && !mustChange) {
      router.replace(CHANGE_PASSWORD_SUCCESS_HREF);
    }
  }, [mustChange, router, snapshot.active]);

  const status = !snapshot.active
    ? "Sign in to continue."
    : mustChange
      ? "Change your password to continue."
      : "Opening workflows…";

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16 outline-none"
    >
      <p role="status" className="text-sm" style={{ color: "var(--ff-muted)" }}>
        {status}
      </p>
    </main>
  );
}
