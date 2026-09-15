"use client";

import { useState } from "react";
import {
  CHANGE_PASSWORD_SUCCESS_HREF,
  changePasswordClientError,
  changePasswordFailureMessage,
  changePasswordFormIsSubmittable,
  clearChangePasswordForm,
  emptyChangePasswordForm,
  type ChangePasswordForm,
} from "@/lib/change-password";
import { changeLocalPassword } from "@/lib/session-client";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

type ChangePasswordChromeProps = {
  onSuccess?: (href: string) => void;
};

export function ChangePasswordChrome({ onSuccess }: ChangePasswordChromeProps) {
  const [form, setForm] = useState<ChangePasswordForm>(emptyChangePasswordForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const clientError = changePasswordClientError(form);
    const password = form.password;
    setForm(clearChangePasswordForm());
    setError(null);
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    const result = await changeLocalPassword(password);
    setPending(false);
    if (!result.ok) {
      setError(
        changePasswordFailureMessage(result.statusCode, result.problem.detail),
      );
      return;
    }
    onSuccess?.(CHANGE_PASSWORD_SUCCESS_HREF);
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
          aria-labelledby="change-password-heading"
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
            id="change-password-heading"
            className="mt-2 font-semibold tracking-tight"
            style={{ fontSize: "var(--ff-type-heading)" }}
          >
            Change password
          </h1>
          <p className="mt-2" style={{ color: "var(--ff-muted)" }}>
            A one-time bootstrap password must be changed before you can
            continue. This cannot be skipped.
          </p>

          <form
            className="mt-6 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="grid gap-1 text-sm">
              <span className="font-medium">New password</span>
              <input
                name="password"
                type="password"
                autoComplete="new-password"
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
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Confirm password</span>
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
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
            </label>
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
                style={{
                  background: "var(--ff-danger-surface)",
                  color: "var(--ff-danger)",
                }}
              >
                <span aria-hidden="true">!</span>
                <span>{error}</span>
              </p>
            ) : null}
            <button
              type="submit"
              disabled={pending || !changePasswordFormIsSubmittable(form)}
              className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                background: "var(--ff-accent)",
                color: "var(--ff-accent-foreground)",
                borderRadius: "var(--ff-radius)",
              }}
            >
              {pending ? "Changing password…" : "Change password"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
