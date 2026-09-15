"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { LoginChrome } from "@/components/session/LoginChrome";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { LOGIN_SUCCESS_HREF } from "@/lib/local-login";
import { loadCurrentSession } from "@/lib/session-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

type SignedOutGateProps = {
  children: ReactNode;
};

export function SignedOutGate({ children }: SignedOutGateProps) {
  const embed = useEmbedMode();
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (embed) {
      return;
    }
    let cancelled = false;
    void loadCurrentSession().finally(() => {
      if (!cancelled) {
        setChecked(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [embed]);

  if (embed) {
    return children;
  }

  if (!checked) {
    return (
      <div
        className={`${FF_SHELL_ROOT_CLASS} flex h-full min-h-full flex-col`}
        data-ff-tokens={FF_SHELL_ROOT_VALUE}
        style={{ background: "var(--ff-canvas)", color: "var(--ff-text)" }}
      >
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16 outline-none"
        >
          <p role="status" className="text-sm" style={{ color: "var(--ff-muted)" }}>
            Checking session…
          </p>
        </main>
      </div>
    );
  }

  if (!snapshot.active) {
    return (
      <LoginChrome
        onSuccess={(href = LOGIN_SUCCESS_HREF) => {
          router.replace(href);
        }}
      />
    );
  }

  return children;
}
