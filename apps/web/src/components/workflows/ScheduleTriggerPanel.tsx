"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { publishedRunVersions } from "@/lib/execution-replay";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  createScheduleTrigger,
  deleteScheduleTrigger,
  disableScheduleTrigger,
  enableScheduleTrigger,
  listScheduleTriggers,
  updateScheduleTrigger,
} from "@/lib/schedule-trigger-client";
import {
  COMMON_IANA_TIMEZONES,
  SCHEDULE_CATCH_UP_HELP,
  SCHEDULE_CATALOG_FALLBACK_MESSAGE,
  SCHEDULE_CSRF_HELP,
  SCHEDULE_EXPRESSION_HELP,
  SCHEDULE_FORBIDDEN_MESSAGE,
  SCHEDULE_MAX_CATCH_UP,
  SCHEDULE_MISFIRE_POLICIES,
  SCHEDULE_OVERLAP_HELP,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_PUBLISHED_ONLY_HELP,
  SCHEDULE_TIMEZONE_HELP,
  SCHEDULE_VIEW_FORBIDDEN_MESSAGE,
  SCHEDULE_YAML_HELP,
  canManageScheduleTriggers,
  canViewScheduleTriggers,
  editorScheduleTriggersHref,
  emptyScheduleTriggerDraft,
  isScheduleCatalogFallback,
  isScheduleTriggerAuthFailure,
  scheduleExpressionLabel,
  scheduleTriggerAuthFailureMessage,
  scheduleTriggerHelp,
  seedDraftFromRecord,
  seedDraftFromYaml,
  yamlScheduleTriggers,
  type ScheduleExpressionKind,
  type ScheduleMisfirePolicy,
  type ScheduleOverlapPolicy,
  type ScheduleTriggerDraft,
  type ScheduleTriggerRecord,
} from "@/lib/schedule-trigger-contract";
import { fetchWorkflowCatalog, listWorkflowVersions } from "@/lib/workflow-client";
import type { WorkflowCatalog, WorkflowVersion } from "@/lib/workflow-types";
import { pushNotification } from "@/lib/workspace-notifications";

type ScheduleTriggerPanelProps = {
  identity: DevIdentity;
  workflowId: string;
  workflowName?: string;
  yaml?: string | null;
  permissions: string[] | null;
  onClose?: () => void;
};

export function ScheduleTriggerPanel({
  identity,
  workflowId,
  workflowName,
  yaml,
  permissions,
  onClose,
}: ScheduleTriggerPanelProps) {
  const canView = canViewScheduleTriggers(permissions);
  const canManage = canManageScheduleTriggers(permissions);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [items, setItems] = useState<ScheduleTriggerRecord[]>([]);
  const [draft, setDraft] = useState<ScheduleTriggerDraft>(() =>
    emptyScheduleTriggerDraft(seedDraftFromYaml(yaml)),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [message, setMessage] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const yamlDeclared = useMemo(() => yamlScheduleTriggers(yaml), [yaml]);
  const published = useMemo(() => publishedRunVersions(versions), [versions]);
  const catalogFallback = isScheduleCatalogFallback(catalog);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchWorkflowCatalog(identity),
      listWorkflowVersions(identity, workflowId),
      canView ? listScheduleTriggers(identity, workflowId) : Promise.resolve(null),
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
        setProblem(list.problem);
        return;
      }
      setItems(list.items);
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
    const list = await listScheduleTriggers(identity, workflowId, catalog);
    setPending(null);
    if (!list.ok) {
      setItems([]);
      setProblem(list.problem);
      return;
    }
    setItems(list.items);
  }

  function patchDraft(patch: Partial<ScheduleTriggerDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onCreate() {
    setPending("create");
    setProblem(null);
    setLocalErrors([]);
    const result = await createScheduleTrigger(identity, workflowId, draft, catalog);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setItems((current) => upsertTrigger(current, result.trigger));
    setMessage(result.message);
    pushNotification({
      kind: "success",
      title: "Schedule trigger created",
      detail: result.message,
    });
  }

  async function onUpdate() {
    if (!editingId) {
      return;
    }
    setPending("update");
    setProblem(null);
    setLocalErrors([]);
    const result = await updateScheduleTrigger(
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
    setItems((current) => upsertTrigger(current, result.trigger));
    setMessage(result.message);
    setEditingId(null);
  }

  async function onToggle(record: ScheduleTriggerRecord) {
    setPending(`toggle:${record.id}`);
    setProblem(null);
    const result =
      record.status === "enabled"
        ? await disableScheduleTrigger(identity, workflowId, record.id, catalog)
        : await enableScheduleTrigger(identity, workflowId, record.id, catalog);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setItems((current) => upsertTrigger(current, result.trigger));
    setMessage(result.message);
  }

  async function onDelete(triggerId: string) {
    setPending(`delete:${triggerId}`);
    setProblem(null);
    const result = await deleteScheduleTrigger(
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
    setMessage(result.message);
    if (editingId === triggerId) {
      setEditingId(null);
    }
  }

  function startEdit(record: ScheduleTriggerRecord) {
    setEditingId(record.id);
    setDraft(seedDraftFromRecord(record));
    setMessage("");
    setLocalErrors([]);
  }

  const authMessage = !canView
    ? SCHEDULE_VIEW_FORBIDDEN_MESSAGE
    : !canManage
      ? SCHEDULE_FORBIDDEN_MESSAGE
      : scheduleTriggerAuthFailureMessage(problem);

  return (
    <section
      id="schedule-triggers"
      aria-labelledby="schedule-triggers-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
            E10.3 · Schedule triggers · contract-fallback
          </p>
          <h2 id="schedule-triggers-heading" className="text-base font-semibold">
            Timezone-explicit schedule config
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            {workflowName ? `${workflowName}. ` : null}
            {scheduleTriggerHelp(catalog)}
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
              href={editorScheduleTriggersHref(workflowId)}
              className="text-sm text-teal-800 underline"
            >
              Editor anchor
            </Link>
          )}
        </div>
      </div>

      <ul className="mt-4 grid gap-2 text-sm text-zinc-600">
        <li>{SCHEDULE_TIMEZONE_HELP}</li>
        <li>{SCHEDULE_EXPRESSION_HELP}</li>
        <li>{SCHEDULE_OVERLAP_HELP}</li>
        <li>{SCHEDULE_CATCH_UP_HELP}</li>
        <li>{SCHEDULE_YAML_HELP}</li>
        <li>{SCHEDULE_PUBLISHED_ONLY_HELP}</li>
      </ul>

      {catalogFallback ? (
        <p role="status" className="mt-4 text-sm text-amber-950">
          {SCHEDULE_CATALOG_FALLBACK_MESSAGE}
        </p>
      ) : null}

      {problem && !isScheduleTriggerAuthFailure(problem) ? (
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
                {item.timezone || "no timezone"}
                {" · "}
                {item.cron || item.interval || "no expression"}
                {item.overlapPolicy ? ` · overlap ${item.overlapPolicy}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="text-sm font-semibold">Configured schedules</h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600">
            No schedule trigger metadata from the API. Create one below when you
            have workflow.edit. Safe defaults stay skip / catchUp=0.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-zinc-200 px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm break-all">{item.id}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {item.timezone} · {scheduleExpressionLabel(item)} · overlap{" "}
                      {item.overlapPolicy} · misfire {item.misfirePolicy} ·
                      catch-up {item.catchUp}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      status {item.status}
                      {item.workflowVersionId
                        ? ` · version ${item.workflowVersionId}`
                        : ""}
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => startEdit(item)}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void onToggle(item)}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                      >
                        {item.status === "disabled" ? "Enable" : "Disable"}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void onDelete(item.id)}
                        className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-900 hover:bg-rose-50 disabled:opacity-60"
                      >
                        {pending === `delete:${item.id}` ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {message ? (
        <p role="status" className="mt-4 text-sm text-zinc-700">
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
            {editingId ? "Update schedule trigger" : "Create schedule trigger"}
          </h3>
          {yaml ? (
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  ...seedDraftFromYaml(yaml),
                }))
              }
              className="justify-self-start text-sm text-teal-800 underline"
            >
              Load timezone and expression from YAML
            </button>
          ) : null}
          <label className="block text-sm">
            <span className="text-zinc-600">Published workflow version</span>
            <select
              value={draft.workflowVersionId}
              onChange={(event) =>
                patchDraft({ workflowVersionId: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
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
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">IANA timezone</span>
            <input
              list="schedule-timezones"
              value={draft.timezone}
              onChange={(event) => patchDraft({ timezone: event.target.value })}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
            <datalist id="schedule-timezones">
              {COMMON_IANA_TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-sm text-zinc-600">Expression</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="schedule-expression-kind"
                checked={draft.expressionKind === "cron"}
                onChange={() =>
                  patchDraft({ expressionKind: "cron" as ScheduleExpressionKind })
                }
              />
              Cron (5-field)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="schedule-expression-kind"
                checked={draft.expressionKind === "interval"}
                onChange={() =>
                  patchDraft({
                    expressionKind: "interval" as ScheduleExpressionKind,
                  })
                }
              />
              Interval (ISO-8601)
            </label>
          </fieldset>
          {draft.expressionKind === "cron" ? (
            <label className="block text-sm">
              <span className="text-zinc-600">Cron</span>
              <input
                value={draft.cron}
                onChange={(event) => patchDraft({ cron: event.target.value })}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
                placeholder="0 0 * * *"
              />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="text-zinc-600">Interval</span>
              <input
                value={draft.interval}
                onChange={(event) => patchDraft({ interval: event.target.value })}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
                placeholder="PT15M"
              />
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-zinc-600">Overlap policy</span>
              <select
                value={draft.overlapPolicy}
                onChange={(event) =>
                  patchDraft({
                    overlapPolicy: event.target.value as ScheduleOverlapPolicy,
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
              >
                {SCHEDULE_OVERLAP_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {policy}
                    {policy === "skip" ? " (safe default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-zinc-600">Misfire policy</span>
              <select
                value={draft.misfirePolicy}
                onChange={(event) =>
                  patchDraft({
                    misfirePolicy: event.target.value as ScheduleMisfirePolicy,
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
              >
                {SCHEDULE_MISFIRE_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {policy}
                    {policy === "ignore" ? " (safe default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-zinc-600">Catch-up (0–{SCHEDULE_MAX_CATCH_UP})</span>
              <select
                value={draft.catchUp}
                onChange={(event) => patchDraft({ catchUp: event.target.value })}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
              >
                {Array.from({ length: SCHEDULE_MAX_CATCH_UP + 1 }, (_, value) => (
                  <option key={value} value={String(value)}>
                    {value}
                    {value === 0 ? " (no catch-up)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-zinc-500">{SCHEDULE_CSRF_HELP}</p>
          {localErrors.length > 0 ? (
            <ul className="text-sm text-rose-900">
              {localErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
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
                  : "Create schedule trigger"}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDraft(
                    emptyScheduleTriggerDraft({
                      ...seedDraftFromYaml(yaml),
                      workflowVersionId: published[0]?.id ?? "",
                    }),
                  );
                }}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                Cancel edit
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-zinc-600">{SCHEDULE_FORBIDDEN_MESSAGE}</p>
      )}
    </section>
  );
}

function upsertTrigger(
  items: ScheduleTriggerRecord[],
  next: ScheduleTriggerRecord | null,
): ScheduleTriggerRecord[] {
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
