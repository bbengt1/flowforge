"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/a11y/Field";
import { ThemePreferenceControl } from "@/components/theme/ThemePreference";
import { CHANGE_PASSWORD_HREF } from "@/lib/change-password";
import { LOGIN_HREF } from "@/lib/local-login";
import { setAdminPassword } from "@/lib/session-client";
import {
  SET_PASSWORD_CHANGE_REQUIRED,
  SET_PASSWORD_FAILED,
  SET_PASSWORD_HREF,
  SET_PASSWORD_QUERY_REJECTED,
  afterAdminPasswordHref,
  clearSetPasswordForm,
  emptySetPasswordForm,
  locationCarriesSetupSecret,
  parseAdminPasswordSet,
  setPasswordClientError,
  setPasswordFailureAction,
  setPasswordFailureMessage,
  setPasswordFormIsSubmittable,
  type SetPasswordForm,
} from "@/lib/set-password";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

type SetPasswordChromeProps = {
  onSuccess?: (href: string) => void;
  onPasswordChangeRequired?: (href: string) => void;
};

const SETUP_QUERY_SERVER = { rejected: false, version: 0 };
let setupQueryNoted = false;
let setupQueryVersion = 0;
let setupQuerySnapshot = SETUP_QUERY_SERVER;

function subscribeSetupQuery(onStoreChange: () => void): () => void {
  const onChange = () => {
    setupQueryVersion += 1;
    onStoreChange();
  };
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

function readSetupQuery(): { rejected: boolean; version: number } {
  if (locationCarriesSetupSecret(window.location.search, window.location.hash)) {
    setupQueryNoted = true;
  }
  if (
    setupQuerySnapshot.rejected !== setupQueryNoted ||
    setupQuerySnapshot.version !== setupQueryVersion
  ) {
    setupQuerySnapshot = {
      rejected: setupQueryNoted,
      version: setupQueryVersion,
    };
  }
  return setupQuerySnapshot;
}

export function SetPasswordChrome({
  onSuccess,
  onPasswordChangeRequired,
}: SetPasswordChromeProps) {
  const router = useRouter();
  const [form, setForm] = useState<SetPasswordForm>(emptySetPasswordForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerSignIn, setOfferSignIn] = useState(false);
  const setupQuery = useSyncExternalStore(
    subscribeSetupQuery,
    readSetupQuery,
    () => SETUP_QUERY_SERVER,
  );
  const visibleError =
    error ?? (setupQuery.rejected ? SET_PASSWORD_QUERY_REJECTED : null);

  useEffect(() => {
    if (!locationCarriesSetupSecret(window.location.search, window.location.hash)) {
      return;
    }
    router.replace(SET_PASSWORD_HREF);
  }, [router, setupQuery.version]);

  async function submit() {
    const clientError = setPasswordClientError(form);
    const setupToken = form.setupToken;
    const password = form.password;
    setForm(clearSetPasswordForm());
    setError(null);
    setOfferSignIn(false);
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    const result = await setAdminPassword({ setupToken, password });
    setPending(false);
    if (!result.ok) {
      if (setPasswordFailureAction(result.statusCode, result.problem.code) === "change-password") {
        setError(SET_PASSWORD_CHANGE_REQUIRED);
        onPasswordChangeRequired?.(CHANGE_PASSWORD_HREF);
        return;
      }
      setOfferSignIn(result.statusCode === 409);
      setError(
        setPasswordFailureMessage(
          result.statusCode,
          result.problem.detail,
          result.retryAfterSeconds,
        ),
      );
      return;
    }
    if (!parseAdminPasswordSet(result.data)) {
      setError(SET_PASSWORD_FAILED);
      return;
    }
    onSuccess?.(afterAdminPasswordHref());
  }

  return (
    <div
      className={`${FF_SHELL_ROOT_CLASS} flex h-full min-h-full flex-col`}
      data-ff-tokens={FF_SHELL_ROOT_VALUE}
      style={{
        background: "var(--ff-canvas)",
        color: "var(--ff-text)",
      }}
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
          aria-labelledby="set-password-heading"
          className="rounded-[var(--ff-radius-lg)] border px-6 py-8"
          style={{
            background: "var(--ff-surface)",
            borderColor: "var(--ff-border)",
          }}
        >
          <div className="mb-4 flex justify-end">
            <ThemePreferenceControl theme="dark" />
          </div>
          <p
            className="text-xs font-medium tracking-wide uppercase"
            style={{ color: "var(--ff-accent)" }}
          >
            FlowForge
          </p>
          <h1
            id="set-password-heading"
            className="mt-2 font-semibold tracking-tight"
            style={{ fontSize: "var(--ff-type-heading)" }}
          >
            Set admin password
          </h1>
          <p className="mt-2" style={{ color: "var(--ff-muted)" }}>
            Enter the one-time setup token and choose the admin password.
            This does not sign you in.
          </p>

          <form
            className="mt-6 grid gap-4"
            method="post"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field
              id="set-password-token"
              label="Setup token"
              className="grid gap-1 text-sm"
              invalid={Boolean(visibleError)}
              errorId={visibleError ? "set-password-error" : undefined}
              hint="Masked. It is not the password you will use to sign in."
            >
              <input
                name="setup_token"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={256}
                value={form.setupToken}
                onChange={(event) =>
                  setForm({ ...form, setupToken: event.target.value })
                }
                className="w-full px-3 py-2 outline-none"
                style={{
                  background: "var(--ff-canvas)",
                  border: "1px solid var(--ff-border)",
                  borderRadius: "var(--ff-radius)",
                  color: "var(--ff-text)",
                }}
              />
            </Field>
            <Field
              id="set-password-new"
              label="New password"
              className="grid gap-1 text-sm"
              invalid={Boolean(visibleError)}
              errorId={visibleError ? "set-password-error" : undefined}
            >
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                maxLength={72}
                value={form.password}
                onChange={(event) =>
                  setForm({ ...form, password: event.target.value })
                }
                className="w-full px-3 py-2 outline-none"
                style={{
                  background: "var(--ff-canvas)",
                  border: "1px solid var(--ff-border)",
                  borderRadius: "var(--ff-radius)",
                  color: "var(--ff-text)",
                }}
              />
            </Field>
            <Field
              id="set-password-confirm"
              label="Confirm password"
              className="grid gap-1 text-sm"
              invalid={Boolean(visibleError)}
              errorId={visibleError ? "set-password-error" : undefined}
              error={
                visibleError ? (
                  <>
                    <span aria-hidden="true">!</span>
                    <span>{visibleError}</span>
                  </>
                ) : undefined
              }
              errorClassName="flex items-start gap-2 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
              errorStyle={{
                background: "var(--ff-danger-surface)",
                color: "var(--ff-danger)",
              }}
            >
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                maxLength={72}
                value={form.confirm}
                onChange={(event) =>
                  setForm({ ...form, confirm: event.target.value })
                }
                className="w-full px-3 py-2 outline-none"
                style={{
                  background: "var(--ff-canvas)",
                  border: "1px solid var(--ff-border)",
                  borderRadius: "var(--ff-radius)",
                  color: "var(--ff-text)",
                }}
              />
            </Field>
            <button
              type="submit"
              disabled={pending || !setPasswordFormIsSubmittable(form)}
              className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                background: "var(--ff-accent)",
                color: "var(--ff-accent-foreground)",
                borderRadius: "var(--ff-radius)",
              }}
            >
              {pending ? "Setting password…" : "Set password"}
            </button>
          </form>
          <p className="mt-4 text-sm" style={{ color: "var(--ff-muted)" }}>
            <a href={LOGIN_HREF}>Sign in</a>
            {offerSignIn
              ? " if this install already has a password."
              : " after the password is set."}
          </p>
        </section>
      </main>
    </div>
  );
}
