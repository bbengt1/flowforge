"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { LOGIN_SUCCESS_HREF } from "@/lib/local-login";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function LoginLanding() {
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );

  useEffect(() => {
    if (snapshot.active) {
      router.replace(LOGIN_SUCCESS_HREF);
    }
  }, [router, snapshot.active]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16 outline-none"
    >
      <p role="status" className="text-sm" style={{ color: "var(--ff-muted)" }}>
        {snapshot.active ? "Opening workflows…" : "Sign in to continue."}
      </p>
    </main>
  );
}
