"use client";

import { useState } from "react";
import { Field } from "@/components/a11y/Field";
import { afterLocalLoginHref } from "@/lib/change-password";
import {
  LOGIN_SUCCESS_HREF,
  clearLoginPassword,
  emptyLoginForm,
  loginFailureMessage,
  loginFormIsSubmittable,
  type LocalLoginForm,
} from "@/lib/local-login";
import {
  OIDC_UNAVAILABLE,
  isSafeAuthorizationUrl,
  oidcFailureMessage,
  oidcIsUnconfigured,
} from "@/lib/oidc-mfa";
import { startOidcLogin } from "@/lib/oidc-mfa-client";
import { loginWithPassword } from "@/lib/session-client";
import { getSessionSnapshot } from "@/lib/session-store";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

type LoginChromeProps = {
  onSuccess?: (href: string) => void;
};

export function LoginChrome({ onSuccess }: LoginChromeProps) {
  const [form, setForm] = useState<LocalLoginForm>(emptyLoginForm);
  const [pending, setPending] = useState(false);
  const [ssoPending, setSsoPending] = useState(false);
  const [ssoAvailable, setSsoAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const identifier = form.identifier.trim();
    const password = form.password;
    setForm(clearLoginPassword({ identifier, password }));
    setPending(true);
    setError(null);
    const result = await loginWithPassword({ identifier, password });
    setPending(false);
    if (!result.ok) {
      setError(loginFailureMessage(result.statusCode, result.problem.detail));
      return;
    }
    const href = afterLocalLoginHref(
      getSessionSnapshot().session.mustChangePassword === true,
    );
    onSuccess?.(href === LOGIN_SUCCESS_HREF ? LOGIN_SUCCESS_HREF : href);
  }

  async function startSso() {
    setForm(clearLoginPassword(form));
    setSsoPending(true);
    setError(null);
    const result = await startOidcLogin();
    if (!result.ok) {
      setSsoPending(false);
      if (oidcIsUnconfigured(result.statusCode, result.problem.detail)) {
        setSsoAvailable(false);
        return;
      }
      setError(oidcFailureMessage(result.statusCode, result.problem.detail));
      return;
    }
    const authorizationUrl = result.data.authorization_url;
    if (!isSafeAuthorizationUrl(authorizationUrl)) {
      setSsoPending(false);
      setError(oidcFailureMessage(502, null));
      return;
    }
    window.location.assign(authorizationUrl);
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
          aria-labelledby="login-heading"
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
            id="login-heading"
            className="mt-2 font-semibold tracking-tight"
            style={{ fontSize: "var(--ff-type-heading)" }}
          >
            Sign in
          </h1>
          <p className="mt-2" style={{ color: "var(--ff-muted)" }}>
            Use your email or username and password.
          </p>

          <form
            className="mt-6 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field
              id="login-identifier"
              label="Email or username"
              className="grid gap-1 text-sm"
              invalid={Boolean(error)}
              errorId={error ? "login-form-error" : undefined}
            >
              <input
                name="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={form.identifier}
                onChange={(event) =>
                  setForm({ ...form, identifier: event.target.value })
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
              id="login-password"
              label="Password"
              className="grid gap-1 text-sm"
              invalid={Boolean(error)}
              errorId={error ? "login-form-error" : undefined}
              error={
                error ? (
                  <>
                    <span aria-hidden="true">!</span>
                    <span>{error}</span>
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
                name="password"
                type="password"
                autoComplete="current-password"
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
            <button
              type="submit"
              disabled={pending || ssoPending || !loginFormIsSubmittable(form)}
              className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                background: "var(--ff-accent)",
                color: "var(--ff-accent-foreground)",
                borderRadius: "var(--ff-radius)",
              }}
            >
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <div className="mt-4 grid gap-3">
            <p className="text-center text-xs" style={{ color: "var(--ff-muted)" }}>
              or
            </p>
            <button
              type="button"
              disabled={pending || ssoPending || !ssoAvailable}
              onClick={() => {
                void startSso();
              }}
              className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                background: "var(--ff-canvas)",
                color: "var(--ff-text)",
                border: "1px solid var(--ff-border)",
                borderRadius: "var(--ff-radius)",
              }}
            >
              {ssoPending ? "Redirecting…" : "Sign in with SSO"}
            </button>
            {!ssoAvailable ? (
              <p className="text-sm" style={{ color: "var(--ff-muted)" }}>
                {OIDC_UNAVAILABLE}
              </p>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
