"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ChangePasswordChrome } from "@/components/session/ChangePasswordChrome";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  CHANGE_PASSWORD_HREF,
  CHANGE_PASSWORD_SUCCESS_HREF,
  decideMustChangeChrome,
  isChangePasswordPath,
} from "@/lib/change-password";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type MustChangePasswordGateProps = {
  children: ReactNode;
};

export function MustChangePasswordGate({ children }: MustChangePasswordGateProps) {
  const embed = useEmbedMode();
  const router = useRouter();
  const pathname = usePathname();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const decision = decideMustChangeChrome({
    embed,
    sessionActive: snapshot.active,
    mustChangePassword: snapshot.session.mustChangePassword === true,
  });

  useEffect(() => {
    if (decision.chrome !== "change-password") {
      return;
    }
    if (!isChangePasswordPath(pathname)) {
      router.replace(CHANGE_PASSWORD_HREF);
    }
  }, [decision.chrome, pathname, router]);

  if (embed || decision.chrome !== "change-password") {
    return children;
  }

  return (
    <ChangePasswordChrome
      onSuccess={(href = CHANGE_PASSWORD_SUCCESS_HREF) => {
        router.replace(href);
      }}
    />
  );
}
