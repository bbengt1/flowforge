"use client";

import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { ChangePasswordChrome } from "@/components/session/ChangePasswordChrome";
import {
  CHANGE_PASSWORD_EMBED_FORBIDDEN,
  CHANGE_PASSWORD_SUCCESS_HREF,
} from "@/lib/change-password";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function ChangePasswordLanding() {
  const embed = useEmbedMode();
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const mustChange = snapshot.session.mustChangePassword === true;

  if (embed) {
    return (
      <p role="status" className="px-6 py-16 text-sm" style={{ color: "var(--ff-muted)" }}>
        {CHANGE_PASSWORD_EMBED_FORBIDDEN}
      </p>
    );
  }

  if (snapshot.active && !mustChange) {
    return (
      <ChangePasswordChrome
        variant="embedded"
        onSuccess={(href = CHANGE_PASSWORD_SUCCESS_HREF) => {
          router.replace(href);
        }}
      />
    );
  }

  const status = !snapshot.active
    ? "Sign in to continue."
    : "Change your password to continue.";

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
