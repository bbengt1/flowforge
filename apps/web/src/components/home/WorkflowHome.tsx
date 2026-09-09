"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { listApprovals } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
import { canSeeApprovalsNav } from "@/lib/approval";
import { canSeeExecutionsNav } from "@/lib/execution";
import { listWorkflowExecutions } from "@/lib/execution-client";
import type { ExecutionRecord } from "@/lib/execution-types";
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
import {
  MANUAL_START_QUERY,
  canOfferManualStart,
} from "@/lib/manual-start-contract";
import { canCreateWorkflows, canSeeWorkflowsNav } from "@/lib/workspace-nav";
import { pushNotification } from "@/lib/workspace-notifications";

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
  const [filters, setFilters] = useState<WorkflowHomeFilters>(EMPTY_WORKFLOW_HOME_FILTERS);
  const [view, setView] = useState<WorkflowHomeView>("list");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");

  const canView = ready && canSeeWorkflowsNav(permissions);
  const canCreate = ready && canCreateWorkflows(permissions);
  const canExecute = ready && canOfferManualStart(permissions);
  const denied = ready && permissions != null && !canSeeWorkflowsNav(permissions);
  const [startWorkflowId, setStartWorkflowId] = useState("");

  const items = useMemo(
    () =>
      buildWorkflowHomeItems(records, {
        environment,
        drafts,
        executions,
        approvals,
        lastRunKnownIds,
      }),
    [records, environment, drafts, executions, approvals, lastRunKnownIds],
  );
  const visible = useMemo(
    () => sortWorkflowHomeItems(filterWorkflowHomeItems(items, filters)),
    [items, filters],
  );
  const options = useMemo(() => uniqueFilterValues(items), [items]);
  const startItem = useMemo(() => {
    if (!startWorkflowId || startWorkflowId === "1") {
      return null;
    }
    return (
      items.find((item) => item.id === startWorkflowId) ?? {
        id: startWorkflowId,
        name: undefined,
      }
    );
  }, [items, startWorkflowId]);

  const refresh = useCallback(async () => {
    const token = refreshGate.current.begin();
    if (!canView) {
      setRecords([]);
      setDrafts(new Map());
      setExecutions([]);
      setLastRunKnownIds(new Set());
      setApprovals([]);
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
    if (refreshGate.current.isCurrent(token)) {
      setPending(null);
    }
  }, [canView, identity, permissions]);

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
        href: created ? `/workflows/${created.id}` : "/workflows",
      });
      if (created) {
        router.push(`/workflows/${created.id}`);
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
    if (!shouldCreate && !shouldImport && !startParam) {
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
        setStartWorkflowId(startParam);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParams, createFromYaml, createName, createSlug]);

  useEffect(() => {
    if (startWorkflowId !== "1") {
      return;
    }
    const first = items.find((item) => item.latestVersionId);
    if (first) {
      setStartWorkflowId(first.id);
    }
  }, [startWorkflowId, items]);

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
          href: created ? `/workflows/${created.id}` : "/workflows",
        });
        if (created) {
          router.push(`/workflows/${created.id}`);
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
      <IsolationIdentityPanel />
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
            <button
              type="button"
              onClick={() => setView("list")}
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
          onStart={(item) => setStartWorkflowId(item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
        />
      ) : (
        <WorkflowHomeCards
          items={visible}
          pending={pending !== null}
          canCreate={canCreate}
          canExecute={canExecute}
          onStart={(item) => setStartWorkflowId(item.id)}
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
  onStart,
  onDuplicate,
  onExport,
}: {
  item: WorkflowHomeItem;
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {item.latestVersionId ? (
        canExecute ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onStart(item)}
            className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
          >
            Start
          </button>
        ) : (
          <span className="text-sm text-zinc-500" title="workflow.execute required">
            Start locked
          </span>
        )
      ) : null}
      <Link
        href={`/workflows/${item.id}`}
        className="text-sm font-medium text-teal-800 underline"
      >
        Open editor
      </Link>
      {item.lastRunId ? (
        <Link
          href={`/executions/${item.lastRunId}`}
          className="text-sm text-zinc-700 underline"
        >
          Last run
        </Link>
      ) : (
        <Link href="/executions" className="text-sm text-zinc-700 underline">
          Executions
        </Link>
      )}
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
  onStart,
  onDuplicate,
  onExport,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
}) {
  return (
    <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white shadow-sm">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div>
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
            <WorkflowMeta item={item} />
          </div>
          <WorkflowActions
            item={item}
            pending={pending}
            canCreate={canCreate}
            canExecute={canExecute}
            onStart={onStart}
            onDuplicate={onDuplicate}
            onExport={onExport}
          />
        </li>
      ))}
    </ul>
  );
}

function WorkflowHomeCards({
  items,
  pending,
  canCreate,
  canExecute,
  onStart,
  onDuplicate,
  onExport,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canExecute: boolean;
  onStart: (item: WorkflowHomeItem) => void;
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
          <Link
            href={`/workflows/${item.id}`}
            className="text-lg font-semibold text-zinc-900 hover:underline"
          >
            {item.name}
          </Link>
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
              onStart={onStart}
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
