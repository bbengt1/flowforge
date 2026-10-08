"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { ProblemBanner } from "@/components/ProblemBanner";
import { CreateScimTokenDialog } from "@/components/scim-tokens/CreateScimTokenDialog";
import {
  invalidateScimTokens,
  useScimTokenList,
} from "@/components/scim-tokens/useScimTokens";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  SCIM_TOKEN_ALREADY_REVOKED,
  SCIM_TOKEN_REVOKE_DESCRIPTION,
  SCIM_TOKEN_REVOKED,
  SCIM_TOKENS_EMBED_UNAVAILABLE,
  SCIM_TOKENS_EMPTY_HEADING,
  SCIM_TOKENS_EMPTY_HELP,
  SCIM_TOKENS_FORBIDDEN,
  SCIM_TOKENS_HELP,
  SCIM_TOKENS_LOAD_FAILED,
  SCIM_TOKENS_TITLE,
  canManageScimTokens,
  formatScimTokenTime,
  scimTokenActiveCountLabel,
  scimTokenCreateAvailability,
  scimTokenCreatorLabel,
  scimTokenLastUsedLabel,
  scimTokenPrefixHint,
  scimTokenProblemKind,
  scimTokenProblemSentence,
  scimTokenRevokeImpact,
  scimTokensView,
  type ScimToken,
  type ScimTokenList,
} from "@/lib/scim-tokens";
import { revokeScimToken } from "@/lib/scim-tokens-client";
import {
  FF_SETTINGS_DANGER_CLASS,
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_HELP_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
  FF_SETTINGS_ROOT_CLASS,
  FF_SETTINGS_TITLE_CLASS,
  FF_SETTINGS_VALUE,
} from "@/lib/settings-wizard-visual";

export function ScimTokensPage() {
  return (
    <div
      data-ff-settings={FF_SETTINGS_VALUE}
      data-scim-tokens-page=""
      className={`${FF_SETTINGS_ROOT_CLASS} space-y-6`}
    >
      <header className="space-y-3">
        <p className={FF_SETTINGS_EYEBROW_CLASS}>Workspace administration</p>
        <h1 className={`text-3xl tracking-tight ${FF_SETTINGS_TITLE_CLASS}`}>
          {SCIM_TOKENS_TITLE}
        </h1>
        <p className={FF_SETTINGS_HELP_CLASS}>{SCIM_TOKENS_HELP}</p>
      </header>
      <ScimTokensAccess />
    </div>
  );
}

/**
 * Admin-only and never in embed. Nothing calls the tokens API until the
 * caller is known to hold `workspace.administer`; the API still decides,
 * including MFA step-up.
 */
function ScimTokensAccess() {
  const embed = useEmbedMode();
  const { identity, ready, permissions } = useWorkspace();
  if (embed) {
    return (
      <p data-scim-tokens-access="embed" className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
        {SCIM_TOKENS_EMBED_UNAVAILABLE}
      </p>
    );
  }
  if (!ready) {
    return <SessionSetupHint purpose="before managing SCIM tokens." />;
  }
  if (permissions == null) {
    return (
      <p className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`} aria-live="polite">
        Checking access…
      </p>
    );
  }
  if (!canManageScimTokens(permissions)) {
    return (
      <p data-scim-tokens-access="forbidden" className={`text-sm ${FF_SETTINGS_DANGER_CLASS}`}>
        {SCIM_TOKENS_FORBIDDEN}
      </p>
    );
  }
  return <ScimTokensBody identity={identity} />;
}

function ScimTokensBody({ identity }: { identity: DevIdentity }) {
  const queryClient = useQueryClient();
  const tokens = useScimTokenList(identity, true);
  const view = scimTokensView({ list: tokens.list, problem: tokens.problem });

  if (view.kind === "blocked") {
    return (
      <section className={FF_SETTINGS_PANEL_CLASS} data-scim-tokens-state={view.reason}>
        <p
          className={`text-sm ${
            view.reason === "not-available" ? FF_SETTINGS_MUTED_CLASS : FF_SETTINGS_DANGER_CLASS
          }`}
        >
          {view.message}
        </p>
        {view.reason === "mfa-required" ? (
          <button
            type="button"
            onClick={tokens.refresh}
            disabled={tokens.pending}
            className={`mt-3 ${FF_SETTINGS_GHOST_CLASS}`}
          >
            {tokens.pending ? "Loading…" : "Try again"}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <ScimTokensPanel
      identity={identity}
      list={view.kind === "ready" ? view.list : null}
      problem={view.kind === "error" ? view.problem : tokens.problem}
      pending={tokens.pending}
      onRefresh={tokens.refresh}
      onChanged={() => void invalidateScimTokens(queryClient, identity)}
    />
  );
}

type ActionNote = { tone: "status" | "alert"; message: string } | null;

function ScimTokensPanel({
  identity,
  list,
  problem,
  pending,
  onRefresh,
  onChanged,
}: {
  identity: DevIdentity;
  list: ScimTokenList | null;
  problem: ProblemDetails | null;
  pending: boolean;
  onRefresh: () => void;
  onChanged: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [note, setNote] = useState<ActionNote>(null);
  const [revokeProblem, setRevokeProblem] = useState<ProblemDetails | null>(null);

  const availability = list ? scimTokenCreateAvailability(list) : null;
  const target = list?.items.find((item) => item.id === revokeId) ?? null;

  async function revoke(token: ScimToken) {
    setRevoking(true);
    setRevokeProblem(null);
    const result = await revokeScimToken(identity, token.id);
    setRevoking(false);
    setRevokeId(null);
    if (!result.ok) {
      const sentence = scimTokenProblemSentence(scimTokenProblemKind(result.problem));
      if (sentence) {
        setNote({ tone: "alert", message: sentence });
      } else {
        setNote(null);
        setRevokeProblem(result.problem);
      }
      return;
    }
    setNote({
      tone: "status",
      message: result.alreadyGone ? SCIM_TOKEN_ALREADY_REVOKED : SCIM_TOKEN_REVOKED,
    });
    onChanged();
  }

  return (
    <section aria-labelledby="scim-tokens-heading" className={FF_SETTINGS_PANEL_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="scim-tokens-heading" className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Tokens
          </h2>
          <p
            data-scim-tokens-count=""
            className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}
            aria-live="polite"
          >
            {list
              ? scimTokenActiveCountLabel(list.items.length, list.maxActive)
              : problem
                ? SCIM_TOKENS_LOAD_FAILED
                : "Loading tokens…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={pending}
            className={FF_SETTINGS_GHOST_CLASS}
          >
            {pending ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            data-scim-tokens-create=""
            disabled={!availability?.allowed}
            aria-describedby={availability && !availability.allowed ? "scim-tokens-create-blocked" : undefined}
            onClick={() => {
              setNote(null);
              setCreateOpen(true);
            }}
            className={FF_SETTINGS_PRIMARY_CLASS}
          >
            Create token
          </button>
        </div>
      </div>

      {availability && !availability.allowed ? (
        <p
          id="scim-tokens-create-blocked"
          data-scim-tokens-create-blocked={availability.reason}
          className={`mt-3 text-sm ${FF_SETTINGS_MUTED_CLASS}`}
        >
          {availability.message}
        </p>
      ) : null}

      {note ? (
        <p
          role={note.tone}
          data-scim-tokens-note={note.tone}
          className={`mt-3 text-sm ${note.tone === "alert" ? FF_SETTINGS_DANGER_CLASS : FF_SETTINGS_MUTED_CLASS}`}
        >
          {note.message}
        </p>
      ) : null}

      {problem && !list ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}
      {revokeProblem ? (
        <div className="mt-4">
          <ProblemBanner problem={revokeProblem} />
        </div>
      ) : null}

      {list && list.items.length === 0 ? (
        <div data-scim-tokens-empty="" className="mt-6 text-center">
          <h3 className={`text-base ${FF_SETTINGS_TITLE_CLASS}`}>{SCIM_TOKENS_EMPTY_HEADING}</h3>
          <p className={`mt-2 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>{SCIM_TOKENS_EMPTY_HELP}</p>
        </div>
      ) : null}

      {list && list.items.length > 0 ? (
        <ul aria-label="Active SCIM tokens" className="mt-4 divide-y divide-border">
          {list.items.map((token) => (
            <ScimTokenRow
              key={token.id}
              token={token}
              onRevoke={() => {
                setNote(null);
                setRevokeProblem(null);
                setRevokeId(token.id);
              }}
            />
          ))}
        </ul>
      ) : null}

      {createOpen && list ? (
        <CreateScimTokenDialog
          identity={identity}
          maxActive={list.maxActive}
          onChanged={onChanged}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}

      {target ? (
        <ConfirmDestructive
          open
          title="Revoke this SCIM token?"
          description={SCIM_TOKEN_REVOKE_DESCRIPTION}
          reversibility="irreversible"
          confirmLabel="Revoke token"
          pending={revoking}
          pendingLabel="Revoking…"
          impact={scimTokenRevokeImpact(target)}
          onClose={() => setRevokeId(null)}
          onConfirm={() => void revoke(target)}
        />
      ) : null}
    </section>
  );
}

function ScimTokenRow({ token, onRevoke }: { token: ScimToken; onRevoke: () => void }) {
  const created = formatScimTokenTime(token.createdAt);
  return (
    <li
      data-scim-token-row={token.id}
      className="flex flex-wrap items-start justify-between gap-3 py-3"
    >
      <div className="min-w-0 space-y-1">
        <p className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>{token.displayName}</p>
        <dl className={`grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr] ${FF_SETTINGS_MUTED_CLASS}`}>
          <dt>Starts with</dt>
          <dd className="font-mono" data-scim-token-prefix="">
            {scimTokenPrefixHint(token)}
          </dd>
          <dt>Created by</dt>
          <dd data-scim-token-creator="">{scimTokenCreatorLabel(token.createdBy)}</dd>
          <dt>Created</dt>
          <dd>{created ? <time dateTime={token.createdAt}>{created}</time> : "Unknown"}</dd>
          <dt>Last used</dt>
          <dd data-scim-token-last-used="">
            {token.lastUsedAt ? (
              <time dateTime={token.lastUsedAt}>{scimTokenLastUsedLabel(token.lastUsedAt)}</time>
            ) : (
              scimTokenLastUsedLabel(null)
            )}
          </dd>
        </dl>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        aria-label={`Revoke ${token.displayName}`}
        className={FF_SETTINGS_GHOST_CLASS}
      >
        Revoke
      </button>
    </li>
  );
}
