import type { OpsConfigKind } from "./ops-config-types.ts";

/**
 * Plain copy for the operational config pages and forms. Developer notes
 * that used to render here (routes, CSRF, tracker ids, field names) are
 * kept below as contract notes and never render.
 */

/** Contract note. Not UI copy: never render it. */
export const CONFIG_CONTRACT_NOTE =
  "Ops config (E4.2, E7.1, E8.1): drafts save with body revision (no If-Match); publish creates an immutable pin; pins come from POST …/select, not GET …/authorized. Foreign or empty lists fail closed with problem+json (403/404). Cluster targets bind type=kubernetes vault credentials; SSH targets bind ssh_private_key credentials. Kubernetes role-template paths come from GET /kubernetes/catalog. ssh.run maxAttempts>0 requires retrySafe; when the live catalog omits retrySafe the flag stays off.";

/** Under the Operational config heading. */
export const CONFIG_PAGE_HELP =
  "Targets, profiles, connections, templates, schemas, and policies for this workspace. Save a draft as often as you like, then publish it to make a fixed version that workflows use. Cluster targets connect to Kubernetes, SSH targets connect to hosts by their known fingerprint, and command profiles are fixed command templates, not a terminal. Keys and kubeconfigs stay in the credentials vault.";

/** Under each config kind's heading. */
export const CONFIG_KIND_PAGE_HELP =
  "Edit a draft, then publish it to make a fixed version that workflows can use.";

const CONFIG_KIND_EXTRA_HELP: Partial<Record<OpsConfigKind, string>> = {
  cluster_target:
    "A cluster target uses a Kubernetes credential from the vault, the cluster's API server, and an optional policy. FlowForge never shows kubeconfigs here.",
  ssh_target:
    "An SSH target uses an SSH key from the vault, a host name, the host's known fingerprint, and an optional list of allowed addresses. FlowForge never shows keys, passwords, or raw logs here. Password sign-in and port forwarding stay off.",
  command_profile:
    "Command profiles are admin-owned command templates with typed parameters. Values are never pasted into a shell. Publishing fixes a version, and later drafts don't change what workflows already use.",
  policy:
    "A Kubernetes policy needs at least one namespace unless it denies everything.",
};

export function configKindPageHelp(kind: OpsConfigKind): string {
  const extra = CONFIG_KIND_EXTRA_HELP[kind];
  return extra ? `${CONFIG_KIND_PAGE_HELP} ${extra}` : CONFIG_KIND_PAGE_HELP;
}

/** Extra line on a config kind's list. */
export const CONFIG_LIST_EXTRA_HELP: Partial<Record<OpsConfigKind, string>> = {
  cluster_target:
    "Each uses a Kubernetes credential from the vault and an optional policy. Kubeconfigs never appear here.",
  policy:
    "Kubernetes policies list the namespaces, kinds, and actions allowed, and which actions need approval.",
};

/** A config list that failed to load. */
export const CONFIG_LIST_PROBLEM_HELP =
  "This list couldn't be loaded, so nothing from it can be picked in a workflow. Check your access, then refresh.";

/** Under a config picker in a form. */
export const CONFIG_PICKER_HELP =
  "Only published versions you can use are listed, by name and version. Secrets never appear here.";

/** A config picker with nothing to pick. */
export const CONFIG_PICKER_EMPTY_OPTION = "Nothing available";

/** Editing a config draft. */
export const CONFIG_DRAFT_HELP =
  "Save keeps your changes in the draft. Publish turns the last saved draft into a fixed version. Unsaved changes are never published.";

/** Under the Kubernetes role template field. */
export function kubernetesRoleTemplateHelp(defaultTemplate: string): string {
  return `Optional. The default role template is ${defaultTemplate}. Cluster-wide roles aren't supported yet.`;
}

/** Retry-safe checkbox on a command profile. */
export const COMMAND_PROFILE_RETRY_SAFE_HELP =
  "Off by default. Turn it on only when this profile can check the remote state without running the command again. Workflow steps that use this profile can retry only when it's on.";

/** When FlowForge couldn't tell whether this server supports retry-safe profiles. */
export const COMMAND_PROFILE_RETRY_SAFE_UNAVAILABLE =
  "FlowForge couldn't confirm that retry-safe profiles are supported here, so the setting stays off.";

/** Under the retry-safe setting when the server sends no note of its own. */
export const COMMAND_PROFILE_RETRY_NOTE =
  "A retry-safe profile has a read-only check that tells FlowForge whether the command already took effect. A retry runs that check first and never repeats the command blindly.";

/** Above the verification check fields. */
export const COMMAND_PROFILE_PROBE_HELP =
  "The check is a read-only command that uses the same parameters as the main command. If it shows the change is already made, the step succeeds without running again. If it shows the change isn't made, the step may run once more.";

/** When the verification check is missing or invalid. */
export const COMMAND_PROFILE_PROBE_INVALID =
  "A retry-safe profile needs a valid read-only check before it can be saved or published.";

/** Credential picker help for cluster targets. */
export const CREDENTIAL_PICKER_KUBERNETES_HELP =
  "Only this workspace's Kubernetes credentials are listed. Kubeconfigs are never shown or pasted here.";

/** Credential picker help for SSH targets. */
export const CREDENTIAL_PICKER_SSH_HELP =
  "Only this workspace's SSH key credentials are listed. Keys, passwords, and host secrets are never shown or pasted here.";

/** Credential picker help for every other kind. */
export const CREDENTIAL_PICKER_HELP =
  "Credentials are listed by name and id only. Kubeconfigs and other secrets are never shown or stored here.";

/** Shown when the credential list for a picker didn't load. */
export const CREDENTIAL_PICKER_PROBLEM =
  "The credential list couldn't be loaded, so none can be picked. Check your access, then refresh.";

/** Under the Published version heading. */
export const CONFIG_VERSION_PAGE_HELP =
  "This published version is read-only. Workflows and runs use exactly this version.";

/** Under the Edit draft heading. */
export const CONFIG_EDIT_PAGE_HELP =
  "Save your changes to the draft, then publish it to make a fixed version. To go back to an earlier version, copy it into the draft. Published versions never change. An SSH command profile can't be edited in place once a workflow version uses it.";

/** Under the Create heading for a new config item. */
export const CONFIG_NEW_PAGE_HELP =
  "Start an editable draft, then publish it when it's ready so workflows can use it. Credentials are picked by display name. Cluster targets never take a kubeconfig, and SSH targets never take keys or passwords.";
