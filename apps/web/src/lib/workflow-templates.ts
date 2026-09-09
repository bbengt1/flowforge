/**
 * Static E6.1 starter templates. There is no template API on main.
 * Each card POSTs an editable draft via existing POST /workflows.
 * Definitions use core-phase nodes only so create/validate succeed.
 */

export type WorkflowTemplate = {
  id: string;
  title: string;
  description: string;
  slugHint: string;
  name: string;
  definitionYaml: string;
};

function starter(name: string, description: string, extraNodes = ""): string {
  return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ${name}
spec:
  description: ${description}
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed value
      with:
        value:
          status: ready
${extraNodes}    - id: done
      type: flow.stop
      name: Stop
  edges:
    - from: seed.result
      to: done.input
`;
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "blank",
    title: "Blank draft",
    description: "Minimal manual workflow with a seed value and stop node.",
    slugHint: "blank-draft",
    name: "Blank draft",
    definitionYaml: starter(
      "blank-draft",
      "Editable blank draft created from the workflow home.",
    ),
  },
  {
    id: "k8s-rollout",
    title: "Kubernetes rollout",
    description:
      "Starter for a reviewed cluster rollout. Bind a published cluster target in the editor.",
    slugHint: "k8s-rollout",
    name: "Kubernetes rollout",
    definitionYaml: starter(
      "k8s-rollout",
      "Starter draft for a Kubernetes rollout. Configure the published cluster target in the editor.",
    ),
  },
  {
    id: "ssh-maintenance",
    title: "SSH maintenance",
    description:
      "Starter for allowlisted remote maintenance. Bind an SSH target and command profile before publish.",
    slugHint: "ssh-maintenance",
    name: "SSH maintenance",
    definitionYaml: starter(
      "ssh-maintenance",
      "Starter draft for SSH maintenance. Select a published target and command profile in the editor.",
    ),
  },
  {
    id: "python-automation",
    title: "Python automation",
    description:
      "Starter for isolated Python work. Script source is published later; this draft is editable now.",
    slugHint: "python-automation",
    name: "Python automation",
    definitionYaml: starter(
      "python-automation",
      "Starter draft for Python automation. Replace the seed with a reviewed script node when available.",
    ),
  },
  {
    id: "go-automation",
    title: "Go automation",
    description:
      "Starter for isolated Go work. Creates an editable draft in this workspace.",
    slugHint: "go-automation",
    name: "Go automation",
    definitionYaml: starter(
      "go-automation",
      "Starter draft for Go automation. Replace the seed with a reviewed script node when available.",
    ),
  },
  {
    id: "composition",
    title: "Condition and delay",
    description:
      "Common core composition: set data, then stop. Add condition/delay nodes in the editor.",
    slugHint: "condition-delay",
    name: "Condition and delay",
    definitionYaml: starter(
      "condition-delay",
      "Common composition starter. Add flow.condition and flow.delay from the core palette.",
    ),
  },
];

export function workflowTemplateById(
  id: string,
): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((item) => item.id === id);
}

export function duplicateWorkflowName(name: string): string {
  const trimmed = name.trim() || "Workflow";
  if (trimmed.endsWith(" copy")) {
    return `${trimmed} 2`;
  }
  return `${trimmed} copy`;
}
