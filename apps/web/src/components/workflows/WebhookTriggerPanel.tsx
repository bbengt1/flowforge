"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ConfirmDestructive,
  DestructiveUndoBar,
  useDestructiveUndo,
} from "@/components/a11y/ConfirmDestructive";
import { Field, FieldError } from "@/components/a11y/Field";
import { CollectionLoadMore } from "@/components/CollectionLoadMore";
import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  appendCollectionItems,
} from "@/lib/collection-page";
import { publishedRunVersions } from "@/lib/execution-replay";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  createWebhookTrigger,
  deleteWebhookTrigger,
  disableWebhookTrigger,
  enableWebhookTrigger,
  listWebhookTriggers,
  rotateWebhookTrigger,
  updateWebhookTrigger,
} from "@/lib/webhook-trigger-client";
import {
  WEBHOOK_CATALOG_FALLBACK_MESSAGE,
  WEBHOOK_CSRF_HELP,
  WEBHOOK_FIELD_MAPPING_HELP,
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_INGRESS_HELP,
  WEBHOOK_PUBLISHED_ONLY_HELP,
  WEBHOOK_RATE_HELP,
  WEBHOOK_REPLAY_HELP,
  WEBHOOK_ROTATE_SECRET_HELP,
  WEBHOOK_SECRET_HELP,
  WEBHOOK_SECRET_LEAK_MESSAGE,
  WEBHOOK_SIGNATURE_HELP,
  WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
  WEBHOOK_YAML_HELP,
  canManageWebhookTriggers,
  canViewWebhookTriggers,
  editorWebhookTriggersHref,
  emptyWebhookTriggerDraft,
  forgetWebhookInlineSecret,
  isWebhookCatalogFallback,
  isWebhookTriggerAuthFailure,
  seedDraftFromRecord,
  seedDraftFromYaml,
  webhookIngressHelp,
  webhookTriggerAuthFailureMessage,
  webhookTriggerHelp,
  yamlWebhookTriggers,
  type WebhookTriggerDraft,
  type WebhookTriggerRecord,
} from "@/lib/webhook-trigger-contract";
import { fetchWorkflowCatalog, listWorkflowVersions } from "@/lib/workflow-client";
import type { WorkflowCatalog, WorkflowVersion } from "@/lib/workflow-types";
import { notifyEditorActivationChanged } from "@/lib/editor-activation";
import {
  WEBHOOK_DELETE_DESCRIPTION,
  webhookDeleteImpact,
} from "@/lib/confirm-destructive";
import { pushNotification } from "@/lib/workspace-notifications";

type WebhookTriggerPanelProps = {
  identity: DevIdentity;
  workflowId: string;
  workflowName?: string;
  yaml?: string | null;
  permissions: string[] | null;
  onClose?: () => void;
};

export function WebhookTriggerPanel({
  identity,
  workflowId,
  workflowName,
  yaml,
  permissions,
  onClose,
}: WebhookTriggerPanelProps) {
  const canView = canViewWebhookTriggers(permissions);
  const canManage = canManageWebhookTriggers(permissions);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [items, setItems] = useState<WebhookTriggerRecord[]>([]);
  const [pageNext, setPageNext] = useState("");
  const [draft, setDraft] = useState<WebhookTriggerDraft>(() =>
    emptyWebhookTriggerDraft(seedDraftFromYaml(yaml)),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rotateSecrets, setRotateSecrets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [message, setMessage] = useState("");
  const [secretLeak, setSecretLeak] = useState(false);
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const yamlDeclared = useMemo(() => yamlWebhookTriggers(yaml), [yaml]);
  const published = useMemo(() => publishedRunVersions(versions), [versions]);
  const catalogFallback = isWebhookCatalogFallback(catalog);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchWorkflowCatalog(identity),
      listWorkflowVersions(identity, workflowId),
      canView
        ? listWebhookTriggers(identity, workflowId, undefined, {
            limit: COLLECTION_PAGE_DEFAULT_LIMIT,
          })
        : Promise.resolve(null),
    ]).then(([catalogResult, versionResult, list]) => {
      if (cancelled) {
        return;
      }
      if (catalogResult.ok) {
        setCatalog(catalogResult.catalog);
      }
      if (versionResult.ok) {
        const publishedItems = publishedRunVersions(versionResult.items);
        setVersions(versionResult.items);
        setDraft((current) =>
          current.workflowVersionId
            ? current
            : { ...current, workflowVersionId: publishedItems[0]?.id ?? "" },
        );
      } else {
        setProblem(versionResult.problem);
      }
      if (!list) {
        return;
      }
      if (!list.ok) {
        setItems([]);
        setPageNext("");
        setProblem(list.problem);
        return;
      }
      setItems(list.items);
      setPageNext(list.next);
      setSecretLeak(list.secretLeak);
    });
    return () => {
      cancelled = true;
    };
  }, [canView, identity, workflowId]);

  async function refresh() {
    if (!canView) {
      return;
    }
    setPending("list");
    setProblem(null);
    const list = await listWebhookTriggers(identity, workflowId, catalog, {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    });
    setPending(null);
    if (!list.ok) {
      setItems([]);
      setPageNext("");
      setProblem(list.problem);
      return;
    }
    setItems(list.items);
    setPageNext(list.next);
    setSecretLeak(list.secretLeak);
  }

  async function loadMore() {
    if (!pageNext || !canView) {
      return;
    }
    setPending("list");
    setProblem(null);
    const list = await listWebhookTriggers(identity, workflowId, catalog, {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor: pageNext,
    });
    setPending(null);
    if (!list.ok) {
      setProblem(list.problem);
      return;
    }
    setItems((current) => appendCollectionItems(current, list.items));
    setPageNext(list.next);
    setSecretLeak(list.secretLeak);
  }

  function patchDraft(patch: Partial<WebhookTriggerDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function noteOutcome(detail: string, leak = false) {
    setMessage(detail);
    setSecretLeak(leak);
    pushNotification({
      kind: "info",
      title: "Webhook trigger",
      detail,
    });
  }

  async function onCreate() {
    if (!canManage) {
      return;
    }
    setPending("create");
    setProblem(null);
    setLocalErrors([]);
    const result = await createWebhookTrigger(identity, workflowId, draft, catalog);
    setDraft((current) => forgetWebhookInlineSecret(current));
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    noteOutcome(result.message, result.leak.leaked);
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    }
    notifyEditorActivationChanged();
    void refresh();
  }

  async function onUpdate() {
    if (!canManage || !editingId) {
      return;
    }
    setPending("update");
    setProblem(null);
    setLocalErrors([]);
    const result = await updateWebhookTrigger(
      identity,
      workflowId,
      editingId,
      draft,
      catalog,
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    noteOutcome(result.message, result.leak.leaked);
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    }
    notifyEditorActivationChanged();
    setEditingId(null);
  }

  async function onRotate(triggerId: string) {
    if (!canManage) {
      return;
    }
    const secret = rotateSecrets[triggerId] ?? "";
    setPending(`rotate:${triggerId}`);
    setProblem(null);
    const result = await rotateWebhookTrigger(
      identity,
      workflowId,
      triggerId,
      secret,
      catalog,
    );
    setRotateSecrets((current) => ({ ...current, [triggerId]: "" }));
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    noteOutcome(result.message, result.leak.leaked);
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    }
  }

  async function onToggle(record: WebhookTriggerRecord) {
    if (!canManage) {
      return;
    }
    const action = record.status === "disabled" ? "enable" : "disable";
    setPending(`${action}:${record.id}`);
    setProblem(null);
    const result =
      action === "disable"
        ? await disableWebhookTrigger(identity, workflowId, record.id, catalog)
        : await enableWebhookTrigger(identity, workflowId, record.id, catalog);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    noteOutcome(result.message, result.leak.leaked);
    notifyEditorActivationChanged();
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    } else {
      void refresh();
    }
  }

  async function onDelete(triggerId: string) {
    if (!canManage) {
      return;
    }
    setPending(`delete:${triggerId}`);
    setProblem(null);
    const result = await deleteWebhookTrigger(
      identity,
      workflowId,
      triggerId,
      catalog,
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setItems((current) => current.filter((item) => item.id !== triggerId));
    if (editingId === triggerId) {
      setEditingId(null);
    }
    notifyEditorActivationChanged();
    noteOutcome(result.message);
  }

  const webhookUndo = useDestructiveUndo((triggerId) => {
    void onDelete(triggerId);
  });

  function startEdit(record: WebhookTriggerRecord) {
    setEditingId(record.id);
    setDraft(seedDraftFromRecord(record));
    setLocalErrors([]);
  }

  const authMessage = !canView
    ? WEBHOOK_VIEW_FORBIDDEN_MESSAGE
    : !canManage
      ? WEBHOOK_FORBIDDEN_MESSAGE
      : webhookTriggerAuthFailureMessage(problem);
  const deleting = items.find((item) => item.id === deleteId) ?? null;

  return (
    <section
      id="webhook-triggers"
      aria-labelledby="webhook-triggers-heading"
      className="rounded-2xl border border-border bg-bg p-5 shadow-sm"
    >
      <DestructiveUndoBar
        ticket={webhookUndo.ticket}
        title="Webhook will be deleted"
        detail={
          items.find((item) => item.id === webhookUndo.ticket?.id)?.publicId
        }
        onUndo={webhookUndo.undo}
        onCommit={webhookUndo.commit}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-fg uppercase">
            E10.2 · Webhook triggers · #113
          </p>
          <h2 id="webhook-triggers-heading" className="text-base font-semibold">
            Replay-safe webhook config
          </h2>
          <p className="mt-1 text-sm text-fg">
            {workflowName ? `${workflowName}. ` : null}
            Pin a published version and enable it. Activation above composes
            that enable + pin — this form is create, rotate, and limits.{" "}
            {webhookTriggerHelp(catalog)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void refresh()}
            className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10 disabled:opacity-60"
          >
            {pending === "list" ? "Refreshing…" : "Refresh"}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10"
            >
              Close
            </button>
          ) : (
            <Link
              href={editorWebhookTriggersHref(workflowId)}
              className="text-sm text-fg underline"
            >
              Editor anchor
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-bg p-3">
        <h3 className="text-sm font-semibold">Public ingress (operators)</h3>
        <p className="mt-1 text-sm text-fg">{webhookIngressHelp(catalog)}</p>
        <p className="mt-2 text-xs text-fg">{WEBHOOK_INGRESS_HELP}</p>
      </div>

      <ul className="mt-4 grid gap-2 text-sm text-fg">
        <li>{WEBHOOK_SIGNATURE_HELP}</li>
        <li>{WEBHOOK_REPLAY_HELP}</li>
        <li>{WEBHOOK_RATE_HELP}</li>
        <li>{WEBHOOK_SECRET_HELP}</li>
        <li>{WEBHOOK_YAML_HELP}</li>
        <li>{WEBHOOK_PUBLISHED_ONLY_HELP}</li>
      </ul>

      {catalogFallback ? (
        <p role="status" className="mt-4 text-sm text-fg">
          {WEBHOOK_CATALOG_FALLBACK_MESSAGE}
        </p>
      ) : null}

      {secretLeak ? (
        <p role="status" className="mt-4 text-sm text-fg">
          {WEBHOOK_SECRET_LEAK_MESSAGE}
        </p>
      ) : null}

      {problem && !isWebhookTriggerAuthFailure(problem) ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}

      {authMessage ? (
        <p role="status" className="mt-4 text-sm font-medium text-danger">
          {authMessage}
        </p>
      ) : null}

      {yamlDeclared.length > 0 ? (
        <div className="mt-4 rounded-xl border border-border bg-bg p-3">
          <h3 className="text-sm font-semibold">Declared in YAML</h3>
          <ul className="mt-2 space-y-1 text-sm text-fg">
            {yamlDeclared.map((item) => (
              <li key={item.id}>
                <span className="font-mono text-xs">{item.id}</span>
                {" · "}
                {item.contentType}
                {item.hasSchema ? " · inputSchema" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="text-sm font-semibold">Configured triggers</h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-fg">
            No webhook trigger metadata from the API. Create one below when you
            have workflow.edit. publicId is server-generated (`wh_`…).
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm break-all">{item.publicId}</p>
                    <p className="mt-1 font-mono text-xs break-all text-fg">
                      {item.ingressPath}
                    </p>
                    <p className="mt-1 text-xs text-fg">
                      status {item.status}
                      {item.secretCredentialId
                        ? ` · secretCredentialId ${item.secretCredentialId}`
                        : ""}
                      {item.workflowVersionId
                        ? ` · version ${item.workflowVersionId}`
                        : ""}
                    </p>
                    <p className="mt-1 text-xs text-fg">
                      {item.contentType} · {item.maxBodyBytes} B ·{" "}
                      {item.rateLimitPerMinute}/min · concurrency{" "}
                      {item.maxConcurrency} · skew {item.clockSkewSeconds}s ·
                      replay {item.replayRetentionSeconds}s
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <CopyButton label="Copy publicId" value={item.publicId} />
                      <CopyButton label="Copy ingress path" value={item.ingressPath} />
                    </div>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => startEdit(item)}
                        className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10 disabled:opacity-60"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void onToggle(item)}
                        className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10 disabled:opacity-60"
                      >
                        {item.status === "disabled" ? "Enable" : "Disable"}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => setDeleteId(item.id)}
                        className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-900 hover:bg-rose-50 disabled:opacity-60"
                      >
                        {pending === `delete:${item.id}` ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Field
                      id={`webhook-rotate-${item.id}`}
                      label="Rotate secret"
                      labelClassName="text-fg"
                    >
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={rotateSecrets[item.id] ?? ""}
                        onChange={(event) =>
                          setRotateSecrets((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm"
                      />
                    </Field>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => void onRotate(item.id)}
                      className="self-end rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10 disabled:opacity-60"
                    >
                      {pending === `rotate:${item.id}` ? "Rotating…" : "Rotate"}
                    </button>
                    <p className="sm:col-span-2 text-xs text-fg">
                      {WEBHOOK_ROTATE_SECRET_HELP}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <CollectionLoadMore
          next={pageNext}
          pending={pending !== null}
          onLoadMore={() => void loadMore()}
          label="Load more triggers"
        />
      </div>

      {message ? (
        <p role="status" className="mt-4 text-sm text-fg">
          {message}
        </p>
      ) : null}

      {canManage ? (
        <form
          className="mt-6 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (editingId) {
              void onUpdate();
              return;
            }
            void onCreate();
          }}
        >
          <h3 className="text-sm font-semibold">
            {editingId ? "Update webhook trigger" : "Create webhook trigger"}
          </h3>
          <p className="text-xs text-fg">{WEBHOOK_FIELD_MAPPING_HELP}</p>
          {yaml ? (
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  ...seedDraftFromYaml(yaml),
                }))
              }
              className="justify-self-start text-sm text-fg underline"
            >
              Load contentType from YAML
            </button>
          ) : null}
          <Field
            id="webhook-version"
            label="Published workflow version"
            labelClassName="text-fg"
            invalid={localErrors.length > 0}
            errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
          >
            <select
              value={draft.workflowVersionId}
              onChange={(event) =>
                patchDraft({ workflowVersionId: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
            >
              <option value="">
                {published.length === 0
                  ? "No published versions"
                  : "Select a published version"}
              </option>
              {published.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.versionNumber} · {version.id}
                </option>
              ))}
            </select>
          </Field>
          {!editingId ? (
            <>
              <fieldset className="grid gap-2">
                <legend className="text-sm text-fg">Secret</legend>
                <Field
                  id="webhook-secret-vault"
                  label="Existing vault webhook_secret"
                  className="flex items-center gap-2 text-sm"
                  labelClassName=""
                  controlPlacement="before-label"
                  invalid={localErrors.length > 0}
                  errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
                >
                  <input
                    type="radio"
                    name="webhook-secret-mode"
                    checked={draft.secretMode === "vault"}
                    onChange={() => patchDraft({ secretMode: "vault" })}
                  />
                </Field>
                <Field
                  id="webhook-secret-inline"
                  label={'One-shot {secret:{secret}} (never shown again)'}
                  className="flex items-center gap-2 text-sm"
                  labelClassName=""
                  controlPlacement="before-label"
                  invalid={localErrors.length > 0}
                  errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
                >
                  <input
                    type="radio"
                    name="webhook-secret-mode"
                    checked={draft.secretMode === "inline"}
                    onChange={() => patchDraft({ secretMode: "inline" })}
                  />
                </Field>
              </fieldset>
              {draft.secretMode === "vault" ? (
                <CredentialRefSelect
                  identity={identity}
                  ready
                  value={draft.secretCredentialId}
                  allowedTypes={["webhook_secret"]}
                  onChange={(credentialId) =>
                    patchDraft({ secretCredentialId: credentialId })
                  }
                />
              ) : (
                <Field
                  id="webhook-inline-secret"
                  label="Inline webhook secret"
                  labelClassName="text-fg"
                  invalid={localErrors.length > 0}
                  errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={draft.inlineSecret}
                    onChange={(event) =>
                      patchDraft({ inlineSecret: event.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm"
                  />
                </Field>
              )}
            </>
          ) : (
            <p className="text-xs text-fg">{WEBHOOK_ROTATE_SECRET_HELP}</p>
          )}
          <Field
            id="webhook-content-type"
            label="Accepted content type"
            labelClassName="text-fg"
            invalid={localErrors.length > 0}
            errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
          >
            <input
              value={draft.contentType}
              onChange={(event) => patchDraft({ contentType: event.target.value })}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="webhook-max-body"
              label="Max body bytes"
              value={draft.maxBodyBytes}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ maxBodyBytes: value })}
            />
            <NumberField
              id="webhook-rate"
              label="Rate / minute"
              value={draft.rateLimitPerMinute}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ rateLimitPerMinute: value })}
            />
            <NumberField
              id="webhook-workspace-rate"
              label="Workspace rate / minute"
              value={draft.workspaceRatePerMinute}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ workspaceRatePerMinute: value })}
            />
            <NumberField
              id="webhook-concurrency"
              label="Max concurrency"
              value={draft.maxConcurrency}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ maxConcurrency: value })}
            />
            <NumberField
              id="webhook-workspace-concurrency"
              label="Workspace max concurrency"
              value={draft.workspaceMaxConcurrency}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ workspaceMaxConcurrency: value })}
            />
            <NumberField
              id="webhook-clock-skew"
              label="Clock skew (seconds)"
              value={draft.clockSkewSeconds}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ clockSkewSeconds: value })}
            />
            <NumberField
              id="webhook-replay-retention"
              label="Replay retention (seconds)"
              value={draft.replayRetentionSeconds}
              invalid={localErrors.length > 0}
              onChange={(value) => patchDraft({ replayRetentionSeconds: value })}
            />
          </div>
          <Field
            id="webhook-field-mapping"
            label="Field mapping (one dest: from per line)"
            labelClassName="text-fg"
            invalid={localErrors.length > 0}
            errorId={localErrors.length > 0 ? "webhook-form-error" : undefined}
          >
            <textarea
              value={draft.fieldMappingText}
              onChange={(event) =>
                patchDraft({ fieldMappingText: event.target.value })
              }
              rows={3}
              placeholder="alertId: payload.id"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-xs"
            />
          </Field>
          <p className="text-xs text-fg">
            Signature-before-parse, timestamp, and replay protection are required.
            There is no off switch. {WEBHOOK_CSRF_HELP}
          </p>
          {localErrors.length > 0 ? (
            <FieldError id="webhook-form-error" className="text-sm text-danger">
              {localErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </FieldError>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending !== null || published.length === 0}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {editingId
                ? pending === "update"
                  ? "Saving…"
                  : "Save settings"
                : pending === "create"
                  ? "Creating…"
                  : "Create webhook trigger"}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDraft(
                    emptyWebhookTriggerDraft({
                      ...seedDraftFromYaml(yaml),
                      workflowVersionId: published[0]?.id ?? "",
                    }),
                  );
                }}
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm hover:bg-fg/10"
              >
                Cancel edit
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-fg">{WEBHOOK_FORBIDDEN_MESSAGE}</p>
      )}
      {deleting ? (
        <ConfirmDestructive
          open
          title="Delete this webhook?"
          description={WEBHOOK_DELETE_DESCRIPTION}
          reversibility="undoable"
          confirmLabel="Delete webhook"
          pending={pending === `delete:${deleting.id}`}
          pendingLabel="Deleting…"
          canConfirm={pending === null}
          impact={webhookDeleteImpact({
            id: deleting.id,
            publicId: deleting.publicId,
            ingressPath: deleting.ingressPath,
            status: deleting.status,
            secretCredentialId: deleting.secretCredentialId,
          })}
          onClose={() => setDeleteId(null)}
          onConfirm={() => {
            const triggerId = deleting.id;
            setDeleteId(null);
            webhookUndo.arm(triggerId);
          }}
        />
      ) : null}
    </section>
  );
}

function NumberField({
  id,
  label,
  value,
  invalid = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={id}
      label={label}
      labelClassName="text-fg"
      invalid={invalid}
      errorId={invalid ? "webhook-form-error" : undefined}
    >
      <input
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm"
      />
    </Field>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded-lg border border-border bg-bg px-2 py-1 text-xs hover:bg-fg/10"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function upsertTrigger(
  items: WebhookTriggerRecord[],
  next: WebhookTriggerRecord | null,
): WebhookTriggerRecord[] {
  if (!next) {
    return items;
  }
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...items];
  }
  const copy = [...items];
  copy[index] = next;
  return copy;
}
