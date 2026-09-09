"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  createWebhookTrigger,
  disableWebhookTrigger,
  enableWebhookTrigger,
  listWebhookTriggers,
  rotateWebhookTrigger,
} from "@/lib/webhook-trigger-client";
import {
  WEBHOOK_COPY_DISMISS_HELP,
  WEBHOOK_CSRF_HELP,
  WEBHOOK_FIELD_MAPPING_HELP,
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_MAP_PENDING_MESSAGE,
  WEBHOOK_RATE_HELP,
  WEBHOOK_REPLAY_HELP,
  WEBHOOK_SECRET_HELP,
  WEBHOOK_SIGNATURE_HELP,
  WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
  WEBHOOK_YAML_HELP,
  canManageWebhookTriggers,
  canViewWebhookTriggers,
  editorWebhookTriggersHref,
  forgetOneTimeSecret,
  isWebhookTriggerAuthFailure,
  seedDraftFromYaml,
  webhookTriggerAuthFailureMessage,
  webhookTriggerHelp,
  yamlWebhookTriggers,
  type WebhookOneTimeReveal,
  type WebhookTriggerDraft,
  type WebhookTriggerRecord,
} from "@/lib/webhook-trigger-contract";
import { fetchWorkflowCatalog } from "@/lib/workflow-client";
import type { WorkflowCatalog } from "@/lib/workflow-types";
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
  const [items, setItems] = useState<WebhookTriggerRecord[]>([]);
  const [draft, setDraft] = useState<WebhookTriggerDraft>(() =>
    seedDraftFromYaml(yaml),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [mapPending, setMapPending] = useState(false);
  const [reveal, setReveal] = useState<WebhookOneTimeReveal>({
    secret: null,
    revealed: false,
  });
  const [message, setMessage] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const yamlDeclared = useMemo(() => yamlWebhookTriggers(yaml), [yaml]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchWorkflowCatalog(identity),
      canView
        ? listWebhookTriggers(identity, workflowId)
        : Promise.resolve(null),
    ]).then(([catalogResult, list]) => {
      if (cancelled) {
        return;
      }
      if (catalogResult.ok) {
        setCatalog(catalogResult.catalog);
      }
      if (!list) {
        return;
      }
      if (!list.ok) {
        setItems([]);
        setProblem(list.problem);
        return;
      }
      setItems(list.items);
      setMapPending(list.usedFallback);
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
    const list = await listWebhookTriggers(identity, workflowId, catalog);
    setPending(null);
    if (!list.ok) {
      setItems([]);
      setProblem(list.problem);
      return;
    }
    setItems(list.items);
    setMapPending(list.usedFallback);
  }

  function patchDraft(patch: Partial<WebhookTriggerDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onCreate() {
    if (!canManage) {
      return;
    }
    setPending("create");
    setProblem(null);
    setLocalErrors([]);
    const result = await createWebhookTrigger(identity, workflowId, draft, catalog);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      setMapPending(result.mapPending);
      return;
    }
    setReveal(result.reveal);
    setMessage(result.message);
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    }
    pushNotification({
      kind: "info",
      title: "Webhook trigger",
      detail: result.message,
    });
    void refresh();
  }

  async function onRotate(triggerId: string) {
    if (!canManage) {
      return;
    }
    setPending(`rotate:${triggerId}`);
    setProblem(null);
    const result = await rotateWebhookTrigger(
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
    setReveal(result.reveal);
    setMessage(result.message);
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
    setMessage(result.message);
    if (result.trigger) {
      setItems((current) => upsertTrigger(current, result.trigger));
    } else {
      void refresh();
    }
  }

  const authMessage = !canView
    ? WEBHOOK_VIEW_FORBIDDEN_MESSAGE
    : !canManage
      ? WEBHOOK_FORBIDDEN_MESSAGE
      : webhookTriggerAuthFailureMessage(problem);

  return (
    <section
      id="webhook-triggers"
      aria-labelledby="webhook-triggers-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
            E10.2 · Webhook triggers
          </p>
          <h2 id="webhook-triggers-heading" className="text-base font-semibold">
            Replay-safe webhook config
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            {workflowName ? `${workflowName}. ` : null}
            {webhookTriggerHelp(catalog)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void refresh()}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
          >
            {pending === "list" ? "Refreshing…" : "Refresh"}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
            >
              Close
            </button>
          ) : (
            <Link
              href={editorWebhookTriggersHref(workflowId)}
              className="text-sm text-teal-800 underline"
            >
              Editor anchor
            </Link>
          )}
        </div>
      </div>

      <ul className="mt-4 grid gap-2 text-sm text-zinc-600">
        <li>{WEBHOOK_SIGNATURE_HELP}</li>
        <li>{WEBHOOK_REPLAY_HELP}</li>
        <li>{WEBHOOK_RATE_HELP}</li>
        <li>{WEBHOOK_SECRET_HELP}</li>
        <li>{WEBHOOK_YAML_HELP}</li>
      </ul>

      {mapPending ? (
        <p role="status" className="mt-4 text-sm text-amber-950">
          {WEBHOOK_MAP_PENDING_MESSAGE}
        </p>
      ) : null}

      {problem && !isWebhookTriggerAuthFailure(problem) ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}

      {authMessage ? (
        <p role="status" className="mt-4 text-sm font-medium text-rose-950">
          {authMessage}
        </p>
      ) : null}

      {yamlDeclared.length > 0 ? (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <h3 className="text-sm font-semibold">Declared in YAML</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
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
          <p className="mt-2 text-sm text-zinc-600">
            No webhook trigger metadata from the API. Create one below when you
            have workflow.edit. Opaque ids are server-generated.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-zinc-200 px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm break-all">{item.opaqueId}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      status {item.status}
                      {item.fingerprint ? ` · ${item.fingerprint}` : ""}
                      {item.secretRef ? ` · secretRef ${item.secretRef}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {item.contentType} · {item.maxBodyBytes} B ·{" "}
                      {item.rateLimitPerMinute}/min · concurrency{" "}
                      {item.maxConcurrent} · skew {item.timestampSkewSeconds}s
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void onRotate(item.id)}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                      >
                        {pending === `rotate:${item.id}` ? "Rotating…" : "Rotate secret"}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void onToggle(item)}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                      >
                        {item.status === "disabled" ? "Enable" : "Disable"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {reveal.revealed && reveal.secret ? (
        <div
          role="status"
          className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4"
        >
          <h3 className="text-sm font-semibold">One-time secret</h3>
          <p className="mt-1 text-sm text-zinc-700">{message}</p>
          <p className="mt-3 font-mono text-sm break-all">{reveal.secret}</p>
          <button
            type="button"
            onClick={() => setReveal((current) => forgetOneTimeSecret(current))}
            className="mt-3 rounded-lg border border-amber-800 bg-white px-3 py-1.5 text-sm hover:bg-amber-100"
          >
            I copied it
          </button>
          <p className="mt-2 text-xs text-zinc-600">{WEBHOOK_COPY_DISMISS_HELP}</p>
        </div>
      ) : message ? (
        <p role="status" className="mt-4 text-sm text-zinc-700">
          {message}
        </p>
      ) : null}

      {canManage ? (
        <form
          className="mt-6 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate();
          }}
        >
          <h3 className="text-sm font-semibold">Create webhook trigger</h3>
          <p className="text-xs text-zinc-500">{WEBHOOK_FIELD_MAPPING_HELP}</p>
          {yaml ? (
            <button
              type="button"
              onClick={() => setDraft(seedDraftFromYaml(yaml))}
              className="justify-self-start text-sm text-teal-800 underline"
            >
              Load schema from YAML
            </button>
          ) : null}
          <label className="block text-sm">
            <span className="text-zinc-600">Accepted content type</span>
            <input
              value={draft.contentType}
              onChange={(event) => patchDraft({ contentType: event.target.value })}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">inputSchema (JSON object)</span>
            <textarea
              value={draft.inputSchemaText}
              onChange={(event) =>
                patchDraft({ inputSchemaText: event.target.value })
              }
              rows={5}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="Max body bytes"
              value={draft.maxBodyBytes}
              onChange={(value) => patchDraft({ maxBodyBytes: value })}
            />
            <NumberField
              label="Rate / minute"
              value={draft.rateLimitPerMinute}
              onChange={(value) => patchDraft({ rateLimitPerMinute: value })}
            />
            <NumberField
              label="Max concurrent"
              value={draft.maxConcurrent}
              onChange={(value) => patchDraft({ maxConcurrent: value })}
            />
            <NumberField
              label="Timestamp skew (seconds)"
              value={draft.timestampSkewSeconds}
              onChange={(value) => patchDraft({ timestampSkewSeconds: value })}
            />
            <NumberField
              label="Replay window (seconds)"
              value={draft.replayWindowSeconds}
              onChange={(value) => patchDraft({ replayWindowSeconds: value })}
            />
          </div>
          <label className="block text-sm">
            <span className="text-zinc-600">
              Field mapping (one dest: from per line)
            </span>
            <textarea
              value={draft.fieldMappingText}
              onChange={(event) =>
                patchDraft({ fieldMappingText: event.target.value })
              }
              rows={3}
              placeholder="alert.id: payload.id"
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs"
            />
          </label>
          <p className="text-xs text-zinc-500">
            Signature-before-parse, timestamp, and replay protection are required.
            There is no off switch. {WEBHOOK_CSRF_HELP}
          </p>
          {localErrors.length > 0 ? (
            <ul className="text-sm text-rose-900">
              {localErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <div>
            <button
              type="submit"
              disabled={pending !== null}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "create" ? "Creating…" : "Create webhook trigger"}
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-zinc-600">{WEBHOOK_FORBIDDEN_MESSAGE}</p>
      )}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <input
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
      />
    </label>
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

