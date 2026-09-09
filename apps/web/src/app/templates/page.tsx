"use client";

import { useRouter } from "next/navigation";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { TemplateGrid } from "@/components/home/WorkflowHome";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { optionalCreateFields } from "@/lib/workflow";
import { createWorkflow } from "@/lib/workflow-client";
import { canCreateWorkflows } from "@/lib/workspace-nav";
import { pushNotification } from "@/lib/workspace-notifications";
import type { WorkflowTemplate } from "@/lib/workflow-templates";

export default function TemplatesPage() {
  const router = useRouter();
  const { identity, ready, permissions } = useWorkspace();
  const canCreate = ready && canCreateWorkflows(permissions);

  async function onSelect(template: WorkflowTemplate) {
    const result = await createWorkflow(identity, {
      definitionYaml: template.definitionYaml,
      ...optionalCreateFields(template.slugHint, template.name),
    });
    if (!result.ok) {
      return;
    }
    const created = result.workflow;
    pushNotification({
      kind: "info",
      title: "Draft created from template",
      detail: template.title,
      href: created ? `/workflows/${created.id}` : "/workflows",
    });
    if (created) {
      router.push(`/workflows/${created.id}`);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.1 · Templates
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Reviewed starting points. Creating from a template always POSTs an
          editable draft in the current workspace. There is no template API
          on main.
        </p>
      </header>
      <IsolationIdentityPanel />
      <TemplateGrid
        canCreate={canCreate}
        pending={false}
        onSelect={(template) => void onSelect(template)}
      />
    </main>
  );
}
