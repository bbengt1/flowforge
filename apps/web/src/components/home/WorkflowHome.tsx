"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { listApprovals } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
import { canSeeApprovalsNav } from "@/lib/approval";
import { canSeeExecutionsNav } from "@/lib/execution";
import { listWorkflowExecutions } from "@/lib/execution-client";
import type { ExecutionRecord } from "@/lib/execution-types";
import {
  productHomeCapabilities,
  templateCreatedEditorHref,
  workflowHomeLastRunHref,
} from "@/lib/product-home";
import { workspaceLookupKey } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { createGenerationGate } from "@/lib/request-generation";
import { optionalCreateFields, shortDigest } from "@/lib/workflow";
import {
  createWorkflow,
  exportWorkflowVersion,
  getWorkflowDraft,
  importValidatedWorkflow,
  listWorkflows,
} from "@/lib/workflow-client";
import type { WorkflowDraft, WorkflowRecord } from "@/lib/workflow-types";
import { subscribeWorkspaceCommands } from "@/lib/workspace-commands";
import { HomeActivationStatus } from "@/components/home/HomeActivationStatus";
import {
  EDITOR_ACTIVATION_CHANGED_EVENT,
  canViewEditorActivation,
} from "@/lib/editor-activation";
import {
  HOME_ACTIVATION,
  HOME_ACTIVATION_FILTERS,
  HOME_ACTIVATION_HEADING_ID,
  HOME_ACTIVATION_HELP,
  WORKFLOW_HOME_LIST_COLUMNS,
  type HomeActivationColumn,
  type HomeActivationFilter,
} from "@/lib/home-activation";
import { loadHomeActivationStates } from "@/lib/home-activation-client";
import {
  EMPTY_WORKFLOW_HOME_FILTERS,
  buildWorkflowHomeItems,
  filterWorkflowHomeItems,
  sortWorkflowHomeItems,
  uniqueFilterValues,
  validationHealthLabel,
  type WorkflowHomeFilters,
  type WorkflowHomeItem,
  type WorkflowHomeView,
} from "@/lib/workflow-home";
import {
  WORKFLOW_TEMPLATES,
  duplicateWorkflowName,
  workflowTemplateById,
  type WorkflowTemplate,
} from "@/lib/workflow-templates";
import { ManualStartPanel } from "@/components/workflows/ManualStartPanel";
import { WebhookTriggerPanel } from "@/components/workflows/WebhookTriggerPanel";
import { ScheduleTriggerPanel } from "@/components/workflows/ScheduleTriggerPanel";
import {
  MANUAL_START_QUERY,
  canOfferManualStart,
} from "@/lib/manual-start-contract";
import {
  WEBHOOK_TRIGGER_QUERY,
  canViewWebhookTriggers,
} from "@/lib/webhook-trigger-contract";
import {
  SCHEDULE_TRIGGER_QUERY,
  canViewScheduleTriggers,
} from "@/lib/schedule-trigger-contract";
import {
  TEST_RUN_HELP,
  canOfferHomeTestRun,
  testRunVersionHints,
} from "@/lib/editor-test-run";
import { runPublishedTestVersion } from "@/lib/editor-test-run-client";
import { canCreateWorkflows, canSeeWorkflowsNav } from "@/lib/workspace-nav";
import { pushNotification } from "@/lib/workspace-notifications";
import {
  homeSatelliteOverlayTriggerId,
  restoreSatelliteOverlayFocus,
  satelliteOverlayAfterEscape,
  type HomeSatelliteOverlayId,
} from "@/lib/rewrite-satellite-a11y";

export function WorkflowHome() {
  const { identity } = useWorkspace();
  return <WorkflowHomeSession key={workspaceLookupKey(identity)} />;
}

function WorkflowHomeSession() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { identity, ready, permissions, environment } = useWorkspace();
  const importRef = useRef<HTMLInputElement>(null);
  const consumedQuery = useRef(false);
  const refreshGate = useRef(createGenerationGate());
  const [records, setRecords] = useState<WorkflowRecord[]>([]);
  const [drafts, setDrafts] = useState<Map<string, WorkflowDraft>>(new Map());
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [lastRunKnownIds, setLastRunKnownIds] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [activations, setActivations] = useState<
    Map<string, HomeActivationColumn>
  >(new Map());
  const [filters, setFilters] = useState<WorkflowHomeFilters>(EMPTY_WORKFLOW_HOME_FILTERS);
  const [view, setView] = useState<WorkflowHomeView>("list");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");

  const canView = ready && canSeeWorkflowsNav(permissions);
  const canCreate = ready && canCreateWorkflows(permissions);
  const rowCapabilities = productHomeCapabilities(ready ? permissions : null);
  const canExecute =
    ready && canOfferManualStart(permissions) && rowCapabilities.canExecute;
  const canPublish = ready && rowCapabilities.canPublish;
  const canViewWebhooks =
    ready && canViewWebhookTriggers(permissions) && rowCapabilities.canViewWebhooks;
  const canViewSchedules =
    ready &&
    canViewScheduleTriggers(permissions) &&
    rowCapabilities.canViewSchedules;
  const canSeeLastRun = ready && rowCapabilities.canSeeLastRun;
  const canViewActivation = ready && canViewEditorActivation(permissions);
  const denied = ready && permissions != null && !canSeeWorkflowsNav(permissions);
  const [startWorkflowId, setStartWorkflowId] = useState("");
  const [webhookWorkflowId, setWebhookWorkflowId] = useState("");
  const [scheduleWorkflowId, setScheduleWorkflowId] = useState("");
  const lastHomeOverlay = useRef<{
    kind: HomeSatelliteOverlayId;
    id: string;
  } | null>(null);

  const items = useMemo(
    () =>
      buildWorkflowHomeItems(records, {
        environment,
        drafts,
        executions,
        approvals,
        lastRunKnownIds,
        activations,
      }),
    [records, environment, drafts, executions, approvals, lastRunKnownIds, activations],
  );
  const visible = useMemo(
    () => sortWorkflowHomeItems(filterWorkflowHomeItems(items, filters)),
    [items, filters],
  );
  const options = useMemo(() => uniqueFilterValues(items), [items]);
  const resolvedStartId =
    startWorkflowId === "1"
      ? (items.find((item) => item.latestVersionId)?.id ?? "")
      : startWorkflowId;
  const startItem = useMemo(() => {
    if (!resolvedStartId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedStartId) ?? {
        id: resolvedStartId,
        name: undefined,
      }
    );
  }, [items, resolvedStartId]);
  const resolvedWebhookId =
    webhookWorkflowId === "1"
      ? (items[0]?.id ?? "")
      : webhookWorkflowId;
  const webhookItem = useMemo(() => {
    if (!resolvedWebhookId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedWebhookId) ?? {
        id: resolvedWebhookId,
        name: undefined,
      }
    );
  }, [items, resolvedWebhookId]);
  const resolvedScheduleId =
    scheduleWorkflowId === "1"
      ? (items[0]?.id ?? "")
      : scheduleWorkflowId;
  const scheduleItem = useMemo(() => {
    if (!resolvedScheduleId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedScheduleId) ?? {
        id: resolvedScheduleId,
        name: undefined,
      }
    );
  }, [items, resolvedScheduleId]);

  const refresh = useCallback(async () => {
    const token = refreshGate.current.begin();
    if (!canView) {
      setRecords([]);
      setDrafts(new Map());
      setExecutions([]);
      setLastRunKnownIds(new Set());
      setApprovals([]);
      setActivations(new Map());
      setPending(null);
      return;
    }
    setPending("list");
    setProblem(null);
    const list = await listWorkflows(identity);
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    if (!list.ok) {
      setPending(null);
      setProblem(list.problem);
      return;
    }
    setRecords(list.items);
    const draftEntries = await Promise.all(
      list.items.map(async (item) => {
        const draft = await getWorkflowDraft(identity, item.id);
        return [item.id, draft.ok ? draft.draft : null] as const;
      }),
    );
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    const nextDrafts = new Map<string, WorkflowDraft>();
    for (const [id, draft] of draftEntries) {
      if (draft) {
        nextDrafts.set(id, draft);
      }
    }
    setDrafts(nextDrafts);
    if (canSeeExecutionsNav(permissions ?? [])) {
      const runEntries = await Promise.all(
        list.items.map(async (item) => {
          const runs = await listWorkflowExecutions(identity, item.id, {
            limit: 1,
          });
          return [item.id, runs.ok ? runs.items : null] as const;
        }),
      );
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      const nextRuns: ExecutionRecord[] = [];
      const known = new Set<string>();
      for (const [id, items] of runEntries) {
        if (!items) {
          continue;
        }
        known.add(id);
        nextRuns.push(...items);
      }
      setExecutions(nextRuns);
      setLastRunKnownIds(known);
    } else {
      setExecutions([]);
      setLastRunKnownIds(new Set());
    }
    if (canSeeApprovalsNav(permissions ?? [])) {
      const inbox = await listApprovals(identity, { status: "pending" });
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      if (inbox.ok) {
        setApprovals(inbox.items);
      }
    } else {
      setApprovals([]);
    }
    if (canViewActivation) {
      const nextActivations = await loadHomeActivationStates(
        identity,
        list.items,
        { canView: canViewActivation },
      );
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      setActivations(nextActivations);
    } else {
      setActivations(new Map());
    }
    if (refreshGate.current.isCurrent(token)) {
      setPending(null);
    }
  }, [canView, canViewActivation, identity, permissions]);

  useEffect(() => {
    const gate = refreshGate.current;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      gate.begin();
    };
  }, [refresh]);

  useEffect(() => {
    function onActivationChanged() {
      void refresh();
    }
    window.addEventListener(EDITOR_ACTIVATION_CHANGED_EVENT, onActivationChanged);
    return () => {
      window.removeEventListener(
        EDITOR_ACTIVATION_CHANGED_EVENT,
        onActivationChanged,
      );
    };
  }, [refresh]);

  const createFromYaml = useCallback(
    async (yaml: string, name?: string, slug?: string) => {
      if (!canCreate) {
        return;
      }
      setPending("create");
      setProblem(null);
      const result = await createWorkflow(identity, {
        definitionYaml: yaml,
        ...optionalCreateFields(slug ?? createSlug, name ?? createName),
      });
      setPending(null);
      if (!result.ok) {
        setProblem(result.problem);
        return;
      }
      const created = result.workflow;
      pushNotification({
        kind: "info",
        title: "Draft created",
        detail: created?.name || "Editable draft ready",
        href: templateCreatedEditorHref(created?.id),
      });
      if (created) {
        router.push(templateCreatedEditorHref(created.id));
      }
    },
    [canCreate, identity, createSlug, createName, router],
  );

  useEffect(() => {
    return subscribeWorkspaceCommands((name) => {
      if (name === "new-workflow") {
        const blank = workflowTemplateById("blank");
        if (blank) {
          void createFromYaml(blank.definitionYaml, createName || blank.name, createSlug);
        }
      }
      if (name === "import-yaml") {
        importRef.current?.click();
      }
    });
  }, [createFromYaml, createName, createSlug]);

  useEffect(() => {
    if (consumedQuery.current) {
      return;
    }
    const shouldCreate = searchParams.get("create") === "1";
    const shouldImport = searchParams.get("import") === "1";
    const startParam = searchParams.get(MANUAL_START_QUERY);
    const webhookParam = searchParams.get(WEBHOOK_TRIGGER_QUERY);
    const scheduleParam = searchParams.get(SCHEDULE_TRIGGER_QUERY);
    if (
      !shouldCreate &&
      !shouldImport &&
      !startParam &&
      !webhookParam &&
      !scheduleParam
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (consumedQuery.current) {
        return;
      }
      if (shouldCreate) {
        consumedQuery.current = true;
        const blank = workflowTemplateById("blank");
        if (blank) {
          void createFromYaml(
            blank.definitionYaml,
            createName || blank.name,
            createSlug,
          );
        }
      }
      if (shouldImport) {
        consumedQuery.current = true;
        importRef.current?.click();
      }
      if (startParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "start", id: startParam };
        setStartWorkflowId(startParam);
      }
      if (webhookParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "webhooks", id: webhookParam };
        setWebhookWorkflowId(webhookParam);
      }
      if (scheduleParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "schedules", id: scheduleParam };
        setScheduleWorkflowId(scheduleParam);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParams, createFromYaml, createName, createSlug]);

  function openHomeOverlay(kind: HomeSatelliteOverlayId, workflowId: string) {
    lastHomeOverlay.current = { kind, id: workflowId };
    if (kind === "start") {
      setStartWorkflowId(workflowId);
      return;
    }
    if (kind === "webhooks") {
      setWebhookWorkflowId(workflowId);
      return;
    }
    setScheduleWorkflowId(workflowId);
  }

  useEffect(() => {
    const open =
      Boolean(startWorkflowId) ||
      Boolean(webhookWorkflowId) ||
      Boolean(scheduleWorkflowId);
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const last = lastHomeOverlay.current;
      const kind: HomeSatelliteOverlayId | null =
        last?.kind ??
        (scheduleWorkflowId
          ? "schedules"
          : webhookWorkflowId
            ? "webhooks"
            : startWorkflowId
              ? "start"
              : null);
      if (!kind) {
        return;
      }
      event.preventDefault();
      const id =
        last?.id ??
        (kind === "start"
          ? startWorkflowId
          : kind === "webhooks"
            ? webhookWorkflowId
            : scheduleWorkflowId);
      const next = satelliteOverlayAfterEscape();
      if (kind === "start") {
        setStartWorkflowId("");
      } else if (kind === "webhooks") {
        setWebhookWorkflowId("");
      } else {
        setScheduleWorkflowId("");
      }
      if (next.restoreFocus) {
        restoreSatelliteOverlayFocus(homeSatelliteOverlayTriggerId(kind, id));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scheduleWorkflowId, startWorkflowId, webhookWorkflowId]);

  async function createFromTemplate(template: WorkflowTemplate) {
    await createFromYaml(template.definitionYaml, template.name, template.slugHint);
  }

  function importFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.trim()) {
        return;
      }
      void (async () => {
        if (!canCreate) {
          return;
        }
        setPending("import");
        setProblem(null);
        const result = await importValidatedWorkflow(identity, text, {
          ...optionalCreateFields(createSlug, createName || file.name.replace(/\.ya?ml$/i, "")),
        });
        setPending(null);
        if (!result.ok) {
          setProblem(result.problem);
          return;
        }
        const created = result.workflow;
        pushNotification({
          kind: "info",
          title: "Draft imported",
          detail: created?.name || "Validated YAML created a draft",
          href: templateCreatedEditorHref(created?.id),
        });
        if (created) {
          router.push(templateCreatedEditorHref(created.id));
        }
      })();
    };
    reader.readAsText(file);
  }

  async function duplicateItem(item: WorkflowHomeItem) {
    const draft = drafts.get(item.id);
    if (!draft) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot duplicate",
        status: 400,
        detail: "Draft YAML is not available for this workflow.",
        instance: `/workflows/${item.id}`,
        code: "invalid-request",
        request_id: "",
      });
      return;
    }
    await createFromYaml(
      draft.definitionYaml,
      duplicateWorkflowName(item.name),
      `${item.slug}-copy`,
    );
  }

  async function testRunItem(item: WorkflowHomeItem) {
    const gate = canOfferHomeTestRun({
      draftRevision: item.draftRevision,
      permissions,
    });
    if (!gate.ok) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot test-run",
        status: gate.reason === "forbidden" ? 403 : 400,
        detail: gate.help,
        instance: `/workflows/${item.id}`,
        code: gate.reason === "forbidden" ? "forbidden" : "invalid-request",
        request_id: "local-home-test-run-16",
      });
      return;
    }
    setPending("test-run");
    setProblem(null);
    // D5 hard line: last saved draftRevision only — not editor YAML.
    // Same compose as editor: identical digest starts latest published.
    const result = await runPublishedTestVersion(identity, {
      workflowId: item.id,
      revision: item.draftRevision,
      dirty: false,
      permissions,
      ...testRunVersionHints({
        draftDigest: item.draftDigest,
        latestVersionDigest: item.latestVersionDigest,
        latestVersionId: item.latestVersionId,
      }),
    });
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    pushNotification({
      kind: "execution",
      title: result.execution.replayed
        ? "Test run replayed"
        : "Test run started",
      detail: `Published test v${result.version.versionNumber} · ${result.execution.status}`,
      href: `/executions/${result.execution.id}`,
    });
    await refresh();
  }

  async function exportItem(item: WorkflowHomeItem) {
    if (!item.latestVersionId) {
      return;
    }
    setPending("export");
    const result = await exportWorkflowVersion(
      identity,
      item.id,
      item.latestVersionId,
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    const blob = new Blob([result.exported.definitionYaml], {
      type: "application/yaml",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.exported.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (denied) {
    return (
      <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
        Workflows are hidden. This workspace role does not include{" "}
        <code className="font-mono text-xs">workflow.view</code>.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {!ready ? (
        <SessionSetupHint purpose="before listing workflows." />
      ) : null}
      {problem ? <ProblemBanner problem={problem} /> : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Workflow home</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Filter safe metadata. Secrets and YAML payloads are never searched here.
              Folders use a name prefix (<code className="font-mono text-xs">ops/…</code>{" "}
              or <code className="font-mono text-xs">ops: …</code>) or a slug like{" "}
              <code className="font-mono text-xs">ops--name</code>.
            </p>
            <p
              id={HOME_ACTIVATION_HEADING_ID}
              className="mt-2 text-sm text-zinc-600"
              data-r6-d2={HOME_ACTIVATION.d2ComposeEnablePlusVersionPin}
            >
              {HOME_ACTIVATION_HELP}
            </p>
            <p className="mt-2 text-sm text-zinc-600">{TEST_RUN_HELP}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending !== null}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
            >
              {pending === "list" ? "Loading…" : "Refresh"}
            </button>
            <div role="group" aria-label="Workflow home view" className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              className={
                view === "list"
                  ? "rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white"
                  : "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              }
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setView("card")}
              aria-pressed={view === "card"}
              className={
                view === "card"
                  ? "rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white"
                  : "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              }
            >
              Cards
            </button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterInput
            label="Search"
            value={filters.query}
            onChange={(value) => setFilters((current) => ({ ...current, query: value }))}
          />
          <FilterSelect
            label="Folder"
            value={filters.folder}
            options={options.folders}
            onChange={(value) => setFilters((current) => ({ ...current, folder: value }))}
          />
          <FilterSelect
            label="Tag"
            value={filters.tag}
            options={options.tags}
            onChange={(value) => setFilters((current) => ({ ...current, tag: value }))}
          />
          <FilterSelect
            label="Owner"
            value={filters.owner}
            options={options.owners}
            onChange={(value) => setFilters((current) => ({ ...current, owner: value }))}
          />
          <FilterSelect
            label="Trigger"
            value={filters.trigger}
            options={options.triggers}
            onChange={(value) => setFilters((current) => ({ ...current, trigger: value }))}
          />
          <FilterSelect
            label="Environment"
            value={filters.environment}
            options={options.environments}
            onChange={(value) =>
              setFilters((current) => ({ ...current, environment: value }))
            }
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={options.statuses}
            onChange={(value) => setFilters((current) => ({ ...current, status: value }))}
          />
          <label className="block text-sm">
            <span className="text-zinc-600">Activation</span>
            <select
              value={filters.activation}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  activation: event.target.value as HomeActivationFilter,
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              {HOME_ACTIVATION_FILTERS.map((option) => (
                <option key={option.value || "any"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">Last run</span>
            <select
              value={filters.lastRun}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastRun: event.target.value as WorkflowHomeFilters["lastRun"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="never">Never</option>
              <option value="running">Running / queued</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="24h">Last 24 hours</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">Last modified</span>
            <select
              value={filters.lastModified}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastModified: event.target.value as WorkflowHomeFilters["lastModified"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
        </div>

        {canCreate ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
            <FilterInput
              label="Name (optional)"
              value={createName}
              onChange={setCreateName}
            />
            <FilterInput
              label="Slug (optional)"
              value={createSlug}
              onChange={setCreateSlug}
            />
            <div className="flex items-end">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  const blank = workflowTemplateById("blank");
                  if (blank) {
                    void createFromYaml(blank.definitionYaml);
                  }
                }}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                Create workflow
              </button>
            </div>
            <div className="flex items-end">
              <label className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50">
                Import YAML
                <input
                  ref={importRef}
                  type="file"
                  accept=".yaml,.yml,text/yaml,application/yaml,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      importFile(file);
                    }
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
        ) : null}
      </section>

      {startItem ? (
        <ManualStartPanel
          identity={identity}
          workflowId={startItem.id}
          workflowName={startItem.name}
          permissions={permissions}
          onClose={() => setStartWorkflowId("")}
        />
      ) : null}

      {webhookItem && canViewWebhooks ? (
        <WebhookTriggerPanel
          identity={identity}
          workflowId={webhookItem.id}
          workflowName={webhookItem.name}
          permissions={permissions}
          onClose={() => setWebhookWorkflowId("")}
        />
      ) : null}

      {scheduleItem && canViewSchedules ? (
        <ScheduleTriggerPanel
          identity={identity}
          workflowId={scheduleItem.id}
          workflowName={scheduleItem.name}
          permissions={permissions}
          onClose={() => setScheduleWorkflowId("")}
        />
      ) : null}

      {visible.length === 0 ? (
        <TemplateGrid
          canCreate={canCreate}
          pending={pending !== null}
          onSelect={(template) => void createFromTemplate(template)}
        />
      ) : view === "list" ? (
        <WorkflowHomeList
          items={visible}
          pending={pending !== null}
          canCreate={canCreate}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
        />
      ) : (
        <WorkflowHomeCards
          items={visible}
          pending={pending !== null}
          canCreate={canCreate}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
        />
      )}
    </div>
  );
}

function FilterInput({
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        autoComplete="off"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function WorkflowMeta({ item }: { item: WorkflowHomeItem }) {
  return (
    <p className="text-xs text-zinc-500">
      {item.status}
      {item.latestVersionNumber ? ` · v${item.latestVersionNumber}` : " · unpublished"}
      {" · "}
      {validationHealthLabel(item.validationHealth)}
      {item.pendingApprovals
        ? ` · ${item.pendingApprovals} approval${item.pendingApprovals === 1 ? "" : "s"}`
        : ""}
      {item.lastRunStatus
        ? ` · last run ${item.lastRunStatus}`
        : item.lastRunKnown
          ? " · never run"
          : ""}
      {item.latestVersionDigest
        ? ` · ${shortDigest(item.latestVersionDigest)}`
        : ""}
    </p>
  );
}

function WorkflowActions({
  item,
  pending,
  canCreate,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
}: {
  item: WorkflowHomeItem;
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
}) {
  const showTestRun = canPublish && canExecute;
  return (
    <div className="flex flex-wrap gap-2">
      {showTestRun ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onTestRun(item)}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Test run
        </button>
      ) : null}
      {item.latestVersionId ? (
        canExecute ? (
          <button
            type="button"
            id={homeSatelliteOverlayTriggerId("start", item.id)}
            disabled={pending}
            onClick={() => onStart(item)}
            className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
          >
            Start published
          </button>
        ) : (
          <span className="text-sm text-zinc-500" title="workflow.execute required">
            Start locked
          </span>
        )
      ) : null}
      {canViewWebhooks ? (
        <button
          type="button"
          id={homeSatelliteOverlayTriggerId("webhooks", item.id)}
          disabled={pending}
          onClick={() => onWebhooks(item)}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Webhooks
        </button>
      ) : null}
      {canViewSchedules ? (
        <button
          type="button"
          id={homeSatelliteOverlayTriggerId("schedules", item.id)}
          disabled={pending}
          onClick={() => onSchedules(item)}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Schedules
        </button>
      ) : null}
      <Link
        href={`/workflows/${item.id}`}
        className="text-sm font-medium text-teal-800 underline"
      >
        Open editor
      </Link>
      {canSeeLastRun ? (
        <Link
          href={workflowHomeLastRunHref({
            workflowId: item.id,
            lastRunId: item.lastRunId,
          })}
          className="text-sm text-zinc-700 underline"
        >
          Last run
        </Link>
      ) : null}
      {canCreate ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onDuplicate(item)}
          className="text-sm text-zinc-700 underline disabled:opacity-60"
        >
          Duplicate
        </button>
      ) : null}
      {item.latestVersionId ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onExport(item)}
          className="text-sm text-zinc-700 underline disabled:opacity-60"
        >
          Export
        </button>
      ) : null}
    </div>
  );
}

function WorkflowHomeList({
  items,
  pending,
  canCreate,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div
        className="mb-0 hidden min-w-[52rem] gap-3 border-b border-zinc-100 px-5 py-3 text-xs font-medium tracking-wide text-zinc-500 uppercase sm:grid sm:grid-cols-[minmax(12rem,1.5fr)_minmax(10rem,1.1fr)_minmax(9rem,1fr)_minmax(7rem,0.8fr)_minmax(12rem,1.3fr)]"
        aria-hidden="true"
      >
        {WORKFLOW_HOME_LIST_COLUMNS.map((column) => (
          <span key={column.id}>{column.label}</span>
        ))}
      </div>
      <ul className="min-w-0 divide-y divide-zinc-100">
        {items.map((item) => (
          <li
            key={item.id}
            className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(12rem,1.5fr)_minmax(10rem,1.1fr)_minmax(9rem,1fr)_minmax(7rem,0.8fr)_minmax(12rem,1.3fr)] sm:items-start"
          >
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase sm:hidden">
                Workflow
              </p>
              <Link
                href={`/workflows/${item.id}`}
                className="text-base font-medium text-zinc-900 hover:underline"
              >
                {item.name}
              </Link>
              <p className="font-mono text-xs text-zinc-500">
                {item.slug}
                {item.folder ? ` · ${item.folder}` : ""}
                {item.owner ? ` · ${item.owner}` : ""}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase sm:hidden">
                Activation
              </p>
              <HomeActivationStatus column={item.activation} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase sm:hidden">
                Status
              </p>
              <WorkflowMeta item={item} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase sm:hidden">
                Last run
              </p>
              <p className="text-xs text-zinc-600">
                {item.lastRunStatus
                  ? item.lastRunStatus
                  : item.lastRunKnown
                    ? "Never run"
                    : "—"}
              </p>
            </div>
            <WorkflowActions
              item={item}
              pending={pending}
              canCreate={canCreate}
              canExecute={canExecute}
              canPublish={canPublish}
              canViewWebhooks={canViewWebhooks}
              canViewSchedules={canViewSchedules}
              canSeeLastRun={canSeeLastRun}
              onStart={onStart}
              onTestRun={onTestRun}
              onWebhooks={onWebhooks}
              onSchedules={onSchedules}
              onDuplicate={onDuplicate}
              onExport={onExport}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowHomeCards({
  items,
  pending,
  canCreate,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Link
              href={`/workflows/${item.id}`}
              className="text-lg font-semibold text-zinc-900 hover:underline"
            >
              {item.name}
            </Link>
            <HomeActivationStatus column={item.activation} />
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-500">{item.slug}</p>
          <div className="mt-3">
            <WorkflowMeta item={item} />
          </div>
          <div className="mt-4">
            <WorkflowActions
              item={item}
              pending={pending}
              canCreate={canCreate}
              canExecute={canExecute}
              canPublish={canPublish}
              canViewWebhooks={canViewWebhooks}
              canViewSchedules={canViewSchedules}
              canSeeLastRun={canSeeLastRun}
              onStart={onStart}
              onTestRun={onTestRun}
              onWebhooks={onWebhooks}
              onSchedules={onSchedules}
              onDuplicate={onDuplicate}
              onExport={onExport}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TemplateGrid({
  canCreate,
  pending,
  onSelect,
}: {
  canCreate: boolean;
  pending: boolean;
  onSelect: (template: WorkflowTemplate) => void;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Start from a template</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Static starters create an editable draft in this workspace. There is no
        template API on main.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {WORKFLOW_TEMPLATES.map((template) => (
          <li
            key={template.id}
            className="rounded-xl border border-zinc-200 p-4"
          >
            <h3 className="font-medium text-zinc-900">{template.title}</h3>
            <p className="mt-1 text-sm text-zinc-600">{template.description}</p>
            {canCreate ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onSelect(template)}
                className="mt-3 rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white hover:bg-teal-900 disabled:opacity-60"
              >
                Create draft
              </button>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">
                Requires <code className="font-mono">workflow.edit</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
