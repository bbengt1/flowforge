"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { afterLocalLoginHref } from "@/lib/change-password";
import { LOGIN_HREF } from "@/lib/local-login";
import {
  OIDC_CALLBACK_PATH,
  oidcCallbackParams,
  oidcFailureMessage,
} from "@/lib/oidc-mfa";
import {
  completeOidcCallbackOnce,
  takeOidcCallbackFlight,
} from "@/lib/oidc-mfa-client";
import { getSessionSnapshot } from "@/lib/session-store";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

export function OidcCallbackChrome() {
  const embed = useEmbedMode();
  const router = useRouter();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (embed) {
      return;
    }
    const params = oidcCallbackParams(window.location.search);
    if (params || window.location.search) {
      window.history.replaceState(null, "", OIDC_CALLBACK_PATH);
    }
    const flight = params
      ? completeOidcCallbackOnce(params)
      : takeOidcCallbackFlight();
    let cancelled = false;
    if (!flight) {
      void Promise.resolve().then(() => {
        if (cancelled) {
          return;
        }
        setPending(false);
        setError(oidcFailureMessage(400, null));
      });
      return () => {
        cancelled = true;
      };
    }
    void flight.then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setPending(false);
        setError(oidcFailureMessage(result.statusCode, result.problem.detail));
        return;
      }
      const href = afterLocalLoginHref(
        getSessionSnapshot().session.mustChangePassword === true,
      );
      router.replace(href);
    });
    return () => {
      cancelled = true;
    };
  }, [embed, router]);

  if (embed) {
    return null;
  }

  return (
    <div
      className={`${FF_SHELL_ROOT_CLASS} flex h-full min-h-full flex-col`}
      data-ff-tokens={FF_SHELL_ROOT_VALUE}
      style={{ background: "var(--ff-canvas)", color: "var(--ff-text)" }}
    >
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col justify-center px-6 py-16 outline-none"
      >
        <section
          aria-labelledby="oidc-callback-heading"
          className="rounded-[var(--ff-radius-lg)] border px-6 py-8"
          style={{
            background: "var(--ff-surface)",
            borderColor: "var(--ff-border)",
          }}
        >
          <p
            className="text-xs font-medium tracking-wide uppercase"
            style={{ color: "var(--ff-accent)" }}
          >
            FlowForge
          </p>
          <h1
            id="oidc-callback-heading"
            className="mt-2 font-semibold tracking-tight"
            style={{ fontSize: "var(--ff-type-heading)" }}
          >
            Signing in
          </h1>
          {error ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
              style={{
                background: "var(--ff-danger-surface)",
                color: "var(--ff-danger)",
              }}
            >
              <span aria-hidden="true">!</span>
              <span>{error}</span>
            </p>
          ) : (
            <p role="status" className="mt-4 text-sm" style={{ color: "var(--ff-muted)" }}>
              {pending ? "Finishing single sign-on…" : "Opening workflows…"}
            </p>
          )}
          {error ? (
            <a
              href={LOGIN_HREF}
              className="mt-4 inline-block text-sm font-semibold"
              style={{ color: "var(--ff-accent)" }}
            >
              Back to sign in
            </a>
          ) : null}
        </section>
      </main>
    </div>
  );
}
