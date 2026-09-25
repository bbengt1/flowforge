/**
 * Static E6.1 starter templates. There is no template API on main.
 * Each card POSTs an editable draft via existing POST /workflows.
 * Definitions use core-phase nodes only so create/validate succeed.
 * metadata.slug is omitted. Create derives the slug from the display name.
 */

export type WorkflowTemplate = {
  id: string;
  title: string;
  description: string;
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
    name: "Blank draft",
    definitionYaml: starter(
      "Blank draft",
      "Editable blank draft created from the workflow home.",
    ),
  },
  {
    id: "k8s-rollout",
    title: "Kubernetes rollout",
    description:
      "Starter for a reviewed cluster rollout. Bind a published cluster target in the editor.",
    name: "Kubernetes rollout",
    definitionYaml: starter(
      "Kubernetes rollout",
      "Starter draft for a Kubernetes rollout. Configure the published cluster target in the editor.",
    ),
  },
  {
    id: "ssh-maintenance",
    title: "SSH maintenance",
    description:
      "Starter for allowlisted remote maintenance. Bind an SSH target and command profile before publish.",
    name: "SSH maintenance",
    definitionYaml: starter(
      "SSH maintenance",
      "Starter draft for SSH maintenance. Select a published target and command profile in the editor.",
    ),
  },
  {
    id: "python-automation",
    title: "Python automation",
    description:
      "Starter for isolated Python work. Add a script.python node from the action wizard. Draft save writes YAML; publish packages/scans/signs and pins the artifact.",
    name: "Python automation",
    definitionYaml: starter(
      "Python automation",
      "Starter draft for Python automation. Add script.python from the action wizard — publish is the artifact pin, not draft save.",
    ),
  },
  {
    id: "go-automation",
    title: "Go automation",
    description:
      "Starter for isolated Go work. Add a script.go node from the action wizard. Draft save writes YAML; publish packages/scans/signs and pins the artifact.",
    name: "Go automation",
    definitionYaml: starter(
      "Go automation",
      "Starter draft for Go automation. Add script.go from the action wizard — publish is the artifact pin, not draft save.",
    ),
  },
  {
    id: "composition",
    title: "Condition and delay",
    description:
      "Common core composition: set data, then stop. Add condition/delay nodes in the editor.",
    name: "Condition and delay",
    definitionYaml: starter(
      "Condition and delay",
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
