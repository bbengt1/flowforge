"use client";

import { useEffect, useState } from "react";
import { EditorActivationChrome } from "@/components/workflows/EditorActivationChrome";
import { ScheduleTriggerPanel } from "@/components/workflows/ScheduleTriggerPanel";
import { VersionHistory } from "@/components/workflows/VersionHistory";
import { WebhookTriggerPanel } from "@/components/workflows/WebhookTriggerPanel";
import { WorkflowConfigPins } from "@/components/workflows/WorkflowConfigPins";
import type { DevIdentity } from "@/lib/identity-headers";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import {
  WORKFLOW_INSPECTOR_DEFAULT_TAB,
  WORKFLOW_INSPECTOR_TABLIST_ID,
  WORKFLOW_INSPECTOR_TABLIST_LABEL,
  WORKFLOW_INSPECTOR_TABS,
  isWorkflowInspectorTab,
  workflowInspectorTabFromHash,
  workflowInspectorTabKeyAction,
  type WorkflowInspectorTab,
} from "@/lib/editor-workflow-inspector";
import type {
  CompareWorkflowResult,
  WorkflowVersion,
} from "@/lib/workflow-types";

const TAB_LABELS: Record<WorkflowInspectorTab, string> = {
  triggers: "Triggers",
  versions: "Versions",
  pins: "Pins",
};

export type WorkflowInspectorAdmin = {
  workflowId?: string;
  workflowName?: string;
  permissions: string[] | null;
  versions: WorkflowVersion[];
  pending: string | null;
  dirty: boolean;
  compareLeft: string;
  compareRight: string;
  compare: CompareWorkflowResult | null;
  onCompareLeft: (value: string) => void;
  onCompareRight: (value: string) => void;
  onCompare: () => void;
  onExport: (version: WorkflowVersion) => void;
  onRestore: (version: WorkflowVersion) => void;
  versionPins?: Record<string, OpsConfigPin[]>;
};

type EditorWorkflowTabsProps = WorkflowInspectorAdmin & {
  identity: DevIdentity;
  canCall: boolean;
  yaml: string;
};

export function EditorWorkflowTabs({
  identity,
  canCall,
  yaml,
  workflowId,
  workflowName,
  permissions,
  versions,
  pending,
  dirty,
  compareLeft,
  compareRight,
  compare,
  onCompareLeft,
  onCompareRight,
  onCompare,
  onExport,
  onRestore,
  versionPins,
}: EditorWorkflowTabsProps) {
  const [tab, setTab] = useState<WorkflowInspectorTab>(
    WORKFLOW_INSPECTOR_DEFAULT_TAB,
  );

  useEffect(() => {
    function syncHash() {
      const next = workflowInspectorTabFromHash(window.location.hash);
      if (next) {
        setTab(next);
      }
    }
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  function selectTab(next: WorkflowInspectorTab) {
    setTab(next);
  }

  return (
    <section className="space-y-3">
      <div
        role="tablist"
        id={WORKFLOW_INSPECTOR_TABLIST_ID}
        aria-label={WORKFLOW_INSPECTOR_TABLIST_LABEL}
        className="sticky top-0 z-10 flex flex-wrap gap-1 rounded-xl border border-zinc-200 bg-white p-1"
        onKeyDown={(event) => {
          if (!isWorkflowInspectorTab(tab)) {
            return;
          }
          const next = workflowInspectorTabKeyAction(event.key, tab);
          if (next !== tab) {
            event.preventDefault();
            selectTab(next);
          }
        }}
      >
        {WORKFLOW_INSPECTOR_TABS.map((item) => {
          const selected = tab === item;
          return (
            <button
              key={item}
              type="button"
              role="tab"
              id={`${WORKFLOW_INSPECTOR_TABLIST_ID}-${item}`}
              aria-selected={selected}
              aria-controls={`${WORKFLOW_INSPECTOR_TABLIST_ID}-${item}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(item)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                selected
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {TAB_LABELS[item]}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${WORKFLOW_INSPECTOR_TABLIST_ID}-${tab}-panel`}
        aria-labelledby={`${WORKFLOW_INSPECTOR_TABLIST_ID}-${tab}`}
        className="space-y-4"
      >
        {tab === "triggers" ? (
          <>
            <EditorActivationChrome
              variant="panel"
              identity={identity}
              workflowId={workflowId}
              permissions={permissions}
            />
            {workflowId ? (
              <>
                <WebhookTriggerPanel
                  identity={identity}
                  workflowId={workflowId}
                  workflowName={workflowName}
                  yaml={yaml}
                  permissions={permissions}
                />
                <ScheduleTriggerPanel
                  identity={identity}
                  workflowId={workflowId}
                  workflowName={workflowName}
                  yaml={yaml}
                  permissions={permissions}
                />
              </>
            ) : (
              <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
                Open a workflow to administer webhook and schedule triggers
                without scrolling past YAML. Contracts stay{" "}
                <code className="font-mono text-xs">/triggers</code> and{" "}
                <code className="font-mono text-xs">/schedules</code>.
              </p>
            )}
          </>
        ) : null}

        {tab === "versions" ? (
          workflowId ? (
            <VersionHistory
              versions={versions}
              pending={pending}
              dirty={dirty}
              compareLeft={compareLeft}
              compareRight={compareRight}
              compare={compare}
              onCompareLeft={onCompareLeft}
              onCompareRight={onCompareRight}
              onCompare={onCompare}
              onExport={onExport}
              onRestore={onRestore}
              versionPins={versionPins}
            />
          ) : (
            <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              Open a workflow to compare, export, or restore a published
              version as a new draft.
            </p>
          )
        ) : null}

        {tab === "pins" ? (
          <WorkflowConfigPins identity={identity} ready={canCall} />
        ) : null}
      </div>
    </section>
  );
}
