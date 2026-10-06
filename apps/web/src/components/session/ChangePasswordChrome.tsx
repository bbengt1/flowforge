"use client";

import { useState, useSyncExternalStore } from "react";
import { Field } from "@/components/a11y/Field";
import { ThemePreferenceControl } from "@/components/theme/ThemePreference";
import {
  CHANGE_PASSWORD_FORCED_HELP,
  CHANGE_PASSWORD_SUCCESS_HREF,
  CHANGE_PASSWORD_VOLUNTARY_HELP,
  changePasswordClientError,
  changePasswordFormIsSubmittable,
  changePasswordFailureMessage,
  changePasswordRequiresCurrentPassword,
  clearChangePasswordForm,
  emptyChangePasswordForm,
  type ChangePasswordForm,
} from "@/lib/change-password";
import { changeLocalPassword } from "@/lib/session-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";

type ChangePasswordChromeProps = {
  onSuccess?: (href: string) => void;
  /** Full-screen door for the must-change gate. Embedded sits in the shell. */
  variant?: "door" | "embedded";
};

const fieldStyle = {
  background: "var(--ff-canvas)",
  border: "1px solid var(--ff-border)",
  borderRadius: "var(--ff-radius)",
  color: "var(--ff-text)",
} as const;

export function ChangePasswordChrome({
  onSuccess,
  variant = "door",
}: ChangePasswordChromeProps) {
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const forced = snapshot.session.mustChangePassword === true;
  const requireCurrent = changePasswordRequiresCurrentPassword(forced);
  const [form, setForm] = useState<ChangePasswordForm>(emptyChangePasswordForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const clientError = changePasswordClientError(form, {
      requireCurrentPassword: requireCurrent,
    });
    const password = form.password;
    const currentPassword = requireCurrent ? form.currentPassword : undefined;
    setForm(clearChangePasswordForm());
    setError(null);
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    const result = await changeLocalPassword(password, currentPassword);
    setPending(false);
    if (!result.ok) {
      setError(
        changePasswordFailureMessage(result.statusCode, result.problem.detail),
      );
      return;
    }
    onSuccess?.(CHANGE_PASSWORD_SUCCESS_HREF);
  }

  const card = (
    <section
      aria-labelledby="change-password-heading"
      className="rounded-[var(--ff-radius-lg)] border px-6 py-8"
      style={{
        background: "var(--ff-surface)",
        borderColor: "var(--ff-border)",
      }}
    >
      {variant === "door" ? (
        <div className="mb-4 flex justify-end">
          <ThemePreferenceControl theme="dark" />
        </div>
      ) : null}
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
        {forced ? CHANGE_PASSWORD_FORCED_HELP : CHANGE_PASSWORD_VOLUNTARY_HELP}
      </p>

      <form
        className="mt-6 grid gap-4"
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {requireCurrent ? (
          <Field
            id="change-password-current"
            label="Current password"
            className="grid gap-1 text-sm"
            invalid={Boolean(error)}
            errorId={error ? "change-password-error" : undefined}
            required
          >
            <input
              name="current_password"
              type="password"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(event) =>
                setForm({ ...form, currentPassword: event.target.value })
              }
              className="w-full px-3 py-2 outline-none"
              style={fieldStyle}
            />
          </Field>
        ) : null}
        <Field
          id="change-password-new"
          label="New password"
          className="grid gap-1 text-sm"
          invalid={Boolean(error)}
          errorId={error ? "change-password-error" : undefined}
        >
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) =>
              setForm({ ...form, password: event.target.value })
            }
            className="w-full px-3 py-2 outline-none"
            style={fieldStyle}
          />
        </Field>
        <Field
          id="change-password-confirm"
          label="Confirm password"
          className="grid gap-1 text-sm"
          invalid={Boolean(error)}
          errorId={error ? "change-password-error" : undefined}
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
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={(event) =>
              setForm({ ...form, confirm: event.target.value })
            }
            className="w-full px-3 py-2 outline-none"
            style={fieldStyle}
          />
        </Field>
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
  );

  if (variant === "embedded") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 py-16 outline-none">
        {card}
      </main>
    );
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
        {card}
      </main>
    </div>
  );
}
