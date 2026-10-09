import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALERT_ACK_APPLIED_MESSAGE,
  ALERT_ACK_FORBIDDEN_MESSAGE,
  ALERT_ACK_IDEMPOTENT_MESSAGE,
  ALERT_ACK_UNAVAILABLE,
  ALERT_DETAIL_PAGE_HELP,
  ALERT_NO_DETAILS,
  ALERTS_EMPTY_MESSAGE,
  ALERTS_PAGE_HELP,
  ALERTS_VIEW_DENIED,
  AUDIT_APPEND_ONLY_HELP,
  AUDIT_EMPTY_MESSAGE,
  AUDIT_PAGE_HELP,
  AUDIT_VIEW_DENIED,
} from "./alert-contract.ts";
import {
  COMMAND_PROFILE_PROBE_HELP,
  COMMAND_PROFILE_PROBE_INVALID,
  COMMAND_PROFILE_RETRY_NOTE,
  COMMAND_PROFILE_RETRY_SAFE_HELP,
  COMMAND_PROFILE_RETRY_SAFE_UNAVAILABLE,
  CONFIG_DRAFT_HELP,
  CONFIG_EDIT_PAGE_HELP,
  CONFIG_KIND_PAGE_HELP,
  CONFIG_LIST_EXTRA_HELP,
  CONFIG_LIST_PROBLEM_HELP,
  CONFIG_NEW_PAGE_HELP,
  CONFIG_PAGE_HELP,
  CONFIG_PICKER_EMPTY_OPTION,
  CONFIG_PICKER_HELP,
  CREDENTIAL_PICKER_HELP,
  CREDENTIAL_PICKER_KUBERNETES_HELP,
  CREDENTIAL_PICKER_PROBLEM,
  CREDENTIAL_PICKER_SSH_HELP,
  CONFIG_VERSION_PAGE_HELP,
  configKindPageHelp,
  kubernetesRoleTemplateHelp,
} from "./config-plain-copy.ts";
import {
  CREDENTIAL_DELETE_HELP,
  CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP,
  CREDENTIAL_DETAIL_HELP,
  CREDENTIAL_DETAIL_PAGE_HELP,
  CREDENTIAL_DETAIL_ROTATE_HELP,
  CREDENTIAL_DETAIL_VIEW_DENIED,
  CREDENTIAL_EVENTS_HELP,
  CREDENTIAL_METADATA_HELP,
  CREDENTIAL_TEST_HELP,
} from "./credential-detail.ts";
import {
  CREDENTIAL_HIDDEN_FIELDS_LABEL,
  CREDENTIAL_NEW_PAGE_HELP,
  CREDENTIAL_VAULT_HELP,
  CREDENTIAL_VAULT_KEYBOARD_HELP,
  CREDENTIAL_VAULT_PAGE_HELP,
  CREDENTIAL_VAULT_STRIP_STOP_HELP,
  CREDENTIAL_VIEW_DENIED,
} from "./credential-vault.ts";
import { CREDENTIAL_NDV_ADD_WIZARD_HELP } from "./credential-ndv-add.ts";
import {
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  EMBED_HOST_DISPLAY_HELP,
  EMBED_URL_SECRET_MESSAGE,
} from "./embed-contract.ts";
import {
  EMBED_HOST_MISMATCH_MESSAGE,
  EMBED_LOCKED_MESSAGE,
  EMBED_TENANCY_MISMATCH_MESSAGE,
} from "./embed-tenancy-contract.ts";
import { kubernetesPolicyGaps, kubernetesPolicyPublishGap } from "./kubernetes.ts";
import {
  MANUAL_START_BAD_INPUT_MESSAGE,
  MANUAL_START_CONFLICT_MESSAGE,
  startBannerMessage,
} from "./manual-start-contract.ts";
import { isStaleSessionProblem } from "./session.ts";
import { SESSION_PROBLEM_CODES } from "./session-contract.ts";
import {
  OPS_CONFIG_SELECT_EMPTY,
  OPS_CONFIG_SELECT_FAILED,
  OPS_CONFIG_SELECT_FORBIDDEN,
  OPS_CONFIG_SELECT_NOT_FOUND,
  OPS_CONFIG_SELECT_SIGNED_OUT,
} from "./ops-config.ts";
import {
  PORTAL_ADMIN_NOT_MEMBER_HELP,
  PORTAL_ASSERTION_HELP,
  PORTAL_BOUNDARY_HELP,
  PORTAL_DENIED_MESSAGE,
  PORTAL_HELP,
  PORTAL_HOSTILE_ISSUER_MESSAGE,
  PORTAL_NOT_MOUNTED_HELP,
  PORTAL_RBAC_HELP,
  PORTAL_REPLAY_MESSAGE,
  PORTAL_SETTINGS_LOADED,
  PORTAL_SETTINGS_UNAVAILABLE,
  PORTAL_TENANCY_HELP,
  PORTAL_TOKEN_CREATED,
  PORTAL_TOKEN_DELIVERED,
  PORTAL_TOKEN_SKIPPED,
} from "./portal-adapter-contract.ts";
import {
  problemBannerHeading,
  safeProblemDetail,
  unreachableProblem,
  upstreamProblem,
} from "./problem.ts";
import {
  PROBLEM_CSRF_HEADING,
  PROBLEM_CSRF_HELP,
  PROBLEM_HEADING_BAD_REQUEST,
  PROBLEM_HEADING_CONFLICT,
  PROBLEM_HEADING_FORBIDDEN,
  PROBLEM_HEADING_NOT_FOUND,
  PROBLEM_HEADING_RATE_LIMITED,
  PROBLEM_HEADING_SERVER,
  PROBLEM_HEADING_UNAUTHENTICATED,
  PROBLEM_HEADING_UNREACHABLE,
  PROBLEM_SENSITIVE_DETAIL,
  PROBLEM_STALE_SESSION_HELP,
  PROBLEM_STALE_SESSION_LINK,
} from "./problem-copy.ts";
import { REQUEST_REFERENCE_LABEL, requestReference } from "./request-reference.ts";
import {
  SCRIPT_RUNTIME_DIGEST_HELP,
  SCRIPT_RUNTIME_EGRESS_HELP,
  SCRIPT_RUNTIME_PROFILE_REQUIRED_HELP,
} from "./script-runtime-contract.ts";
import { SESSION_EMBED_WAITING_HELP } from "./session-embed-contract.ts";

/**
 * Developer wording that must not reach config, alerts, audit, credentials,
 * the shared problem banner, embed chrome, or the portal host: HTTP verbs
 * with routes, CSRF, status codes in text, permission keys, field names,
 * tracker ids, "Chloe UI", the request_id field name, and fail-closed jargon.
 */
const DEVELOPER_COPY =
  /\b(?:GET|POST|PUT|PATCH|DELETE)\b|CSRF|Idempotency-Key|If-Match|problem\+json|\/executions\b|\/workflows\/|\/approvals\/|\/artifact|\/api\/|\/credentials\b|\/audit\b|\/session\b|\/workspace\b|\/embed\/|\/portal\/|\/kubernetes\/|HTTP \d{3}|\b(?:200|201|400|401|403|404|409|410|412|422|429|500|502|503)\b|\b(?:workflow|execution|approval|alert|audit|credential|config|script|membership|platform|embed|session)\.(?:view|execute|cancel|decide|ack|acknowledge|read|write|manage|use|edit|publish|create|delete|revoke|test|rotate|administer|impersonate|embed)\b|\b(?:alert|audit|credential|config)\.[a-z]+\b|usePermission|capabilities\.|ssh\.run|request_id|requestId|\bjti\b|\bmint\b|retrySafe|dnsConstrained|allowedNamespaces|imageDigest|credentialId|type=|deny=|\{id\}|fail-closed|fails? closed|failed closed|\bstub\b|idempotent\b|contract bug|#\d+|\b[ER]\d+(?:\.\d+)?\b|ADV-\d+|Chloe UI|[Tt]his UI/;

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function source(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

/** Text a component can render: JSX text and double-quoted literals. */
function renderedLiterals(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n")
    .filter((line) => !/^\s*import\b|\bfrom "/.test(line))
    .join("\n");
  return [
    ...code.matchAll(/"([^"\n]*)"/g),
    ...code.matchAll(/>([^<>{}]+)</g),
    ...code.matchAll(/>([^<>{}]+)\{/g),
  ]
    .map((match) => match[1].trim())
    .filter(Boolean)
    // Tailwind classes, ids, routes, and data attributes are not copy.
    .filter((literal) => !/^[a-z0-9:/[\]().%_#-]+(?: [a-z0-9:/[\]().%_#-]+)*$/.test(literal))
    // Code between a comparison and a tag, such as `a > b ? (`, is not copy.
    .filter((literal) => !/===|!==|&&|\|\||=>|\?\s*\(|\)\s*\?|\?\.|;\s*$/.test(literal))
    // Calls such as `setLastRequestId(list.requestId);` are not copy either.
    .filter((literal) => !/\w\(|\]\);|^\(/.test(literal));
}

/**
 * Every `title=` must belong to a component prop (Dialog titles) or name an
 * iframe for screen readers, never a native tooltip.
 */
function nativeTitleAttributes(text: string): string[] {
  const found: string[] = [];
  let index = text.indexOf("title=");
  while (index !== -1) {
    const open = text.lastIndexOf("<", index);
    const tag = /^<([A-Za-z][\w.]*)/.exec(text.slice(open))?.[1] ?? "";
    if (!/^[A-Z]/.test(tag) && tag !== "iframe") {
      found.push(`${tag || "?"} at ${index}`);
    }
    index = text.indexOf("title=", index + 1);
  }
  return found;
}

const SURFACES = [
  "app/config/page.tsx",
  "app/config/[kind]/page.tsx",
  "app/config/[kind]/new/page.tsx",
  "app/config/[kind]/[id]/page.tsx",
  "app/config/[kind]/[id]/versions/[versionId]/page.tsx",
  "components/config/AuthorizedResourceSelect.tsx",
  "components/config/CommandProfileForm.tsx",
  "components/config/ConfigDraftEditor.tsx",
  "components/config/ConfigHub.tsx",
  "components/config/ConfigKindList.tsx",
  "components/config/ConfigPublishedDetail.tsx",
  "components/config/ConfigSpecForm.tsx",
  "components/config/CredentialRefSelect.tsx",
  "components/config/KubernetesPolicyForm.tsx",
  "components/config/RuntimeProfileForm.tsx",
  "app/alerts/page.tsx",
  "app/alerts/[id]/page.tsx",
  "components/alerts/AlertList.tsx",
  "components/alerts/AlertDetail.tsx",
  "app/audit/page.tsx",
  "components/audit/AuditBrowser.tsx",
  "app/credentials/page.tsx",
  "app/credentials/new/page.tsx",
  "app/credentials/[id]/page.tsx",
  "components/credentials/CredentialVault.tsx",
  "components/credentials/CredentialWizard.tsx",
  "components/credentials/CredentialVaultListbox.tsx",
  "components/credentials/CredentialDetail.tsx",
  "components/credentials/CredentialTestDialog.tsx",
  "components/credentials/DeleteImpactDialog.tsx",
  "components/workflows/ScriptPublishStatus.tsx",
  "components/ProblemBanner.tsx",
  "components/RequestReference.tsx",
  "components/embed/EmbedChrome.tsx",
  "components/portal/PortalHost.tsx",
] as const;

describe("config, alerts, audit, credentials, and the problem banner use plain copy", () => {
  it("pins the new sentences", () => {
    assert.equal(
      CONFIG_PAGE_HELP,
      "Targets, profiles, connections, templates, schemas, and policies for this workspace. Save a draft as often as you like, then publish it to make a fixed version that workflows use. Cluster targets connect to Kubernetes, SSH targets connect to hosts by their known fingerprint, and command profiles are fixed command templates, not a terminal. Keys and kubeconfigs stay in the credentials vault.",
    );
    assert.equal(
      CONFIG_KIND_PAGE_HELP,
      "Edit a draft, then publish it to make a fixed version that workflows can use.",
    );
    assert.equal(configKindPageHelp("response_schema"), CONFIG_KIND_PAGE_HELP);
    assert.equal(
      CONFIG_DRAFT_HELP,
      "Save keeps your changes in the draft. Publish turns the last saved draft into a fixed version. Unsaved changes are never published.",
    );
    assert.equal(
      CONFIG_PICKER_HELP,
      "Only published versions you can use are listed, by name and version. Secrets never appear here.",
    );
    assert.equal(CONFIG_PICKER_EMPTY_OPTION, "Nothing available");
    assert.equal(
      CONFIG_LIST_PROBLEM_HELP,
      "This list couldn't be loaded, so nothing from it can be picked in a workflow. Check your access, then refresh.",
    );
    assert.equal(
      kubernetesRoleTemplateHelp("edit"),
      "Optional. The default role template is edit. Cluster-wide roles aren't supported yet.",
    );
    assert.equal(
      OPS_CONFIG_SELECT_FORBIDDEN,
      "Your role can't use these. Items from other workspaces are never listed.",
    );
    assert.equal(OPS_CONFIG_SELECT_EMPTY, "Nothing published that you can use in this workspace yet.");
    assert.equal(AUDIT_PAGE_HELP, "Who did what in this workspace, and when. Filter by resource or action to find an entry.");
    assert.equal(
      AUDIT_APPEND_ONLY_HELP,
      "Entries are only ever added to the audit log. Nobody can edit or delete them here.",
    );
    assert.equal(AUDIT_EMPTY_MESSAGE, "No audit entries match these filters.");
    assert.equal(AUDIT_VIEW_DENIED, "Your role can't view the audit log.");
    assert.equal(ALERTS_VIEW_DENIED, "Your role can't view alerts.");
    assert.equal(ALERT_ACK_APPLIED_MESSAGE, "Alert acknowledged.");
    assert.equal(ALERT_ACK_IDEMPOTENT_MESSAGE, "This alert was already acknowledged. Nothing else changed.");
    assert.equal(ALERT_ACK_FORBIDDEN_MESSAGE, "Your role can't acknowledge alerts. The alert wasn't changed.");
    assert.equal(CREDENTIAL_VIEW_DENIED, "Your role can't view credentials.");
    assert.equal(
      CREDENTIAL_VAULT_STRIP_STOP_HELP,
      "FlowForge hid fields that looked like secrets. Stop here and tell your FlowForge admin. Don't paste anything from this page into tickets or screenshots.",
    );
    assert.equal(CREDENTIAL_HIDDEN_FIELDS_LABEL, "Hidden fields:");
    assert.equal(
      CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP,
      "Disable and enable are separate buttons, and the status always reads Active or Disabled.",
    );
    assert.equal(
      EMBED_CHROME_MISSING_SESSION_MESSAGE,
      "This embedded view isn't signed in to FlowForge. Open it again from the app it's part of.",
    );
    assert.equal(
      PROBLEM_CSRF_HEADING,
      "FlowForge couldn't confirm this request came from this page.",
    );
    assert.equal(PROBLEM_CSRF_HELP, "Nothing was changed. Reload the page, then try again.");
    assert.equal(PROBLEM_STALE_SESSION_HELP, "Your session has ended.");
    assert.equal(PROBLEM_STALE_SESSION_LINK, "Sign in again");
    assert.equal(PROBLEM_SENSITIVE_DETAIL, "FlowForge hid the details because they might include a secret.");
    assert.equal(REQUEST_REFERENCE_LABEL, "Reference");
    assert.equal(PORTAL_HELP, "Portal access is not FlowForge authorization. FlowForge checks your access itself.");
    assert.equal(
      PORTAL_REPLAY_MESSAGE,
      "This sign-in token was already used. Select Open FlowForge again to get a new one.",
    );
  });

  it("maps every status to a plain banner heading without a status code", () => {
    const heading = (status: number, code = "x") => problemBannerHeading({ title: "Raw title", status, code });
    assert.equal(heading(400), PROBLEM_HEADING_BAD_REQUEST);
    assert.equal(heading(422), PROBLEM_HEADING_BAD_REQUEST);
    assert.equal(heading(401), PROBLEM_HEADING_UNAUTHENTICATED);
    assert.equal(heading(403), PROBLEM_HEADING_FORBIDDEN);
    assert.equal(heading(404), PROBLEM_HEADING_NOT_FOUND);
    assert.equal(heading(409), PROBLEM_HEADING_CONFLICT);
    assert.equal(heading(429), PROBLEM_HEADING_RATE_LIMITED);
    assert.equal(heading(500), PROBLEM_HEADING_SERVER);
    assert.equal(heading(502, "control-plane-unreachable"), PROBLEM_HEADING_UNREACHABLE);
    assert.equal(safeProblemDetail("token=abc123"), PROBLEM_SENSITIVE_DETAIL);
    for (const problem of [unreachableProblem("/x", "req-1"), upstreamProblem(502, "/x", "req-1")]) {
      assert.doesNotMatch(problem.detail, DEVELOPER_COPY);
      assert.doesNotMatch(problemBannerHeading(problem), /\d{3}/);
    }
  });

  it("shows a request id only as a reference, and never one made in the browser", () => {
    assert.equal(requestReference("req-623"), "req-623");
    assert.equal(requestReference("local-abc"), null);
    assert.equal(requestReference(""), null);
    assert.equal(requestReference(null), null);
    const component = source("components/RequestReference.tsx");
    assert.match(component, /Reference:/);
    assert.doesNotMatch(component, /request_id/);
  });

  it("keeps the Start panel's 400 sentence and routes it through the banner", () => {
    const problem = {
      type: "urn:flowforge:problem:invalid-request",
      title: "Bad Request",
      status: 400,
      detail: "input exceeds 16 KiB",
      instance: "/workflows",
      code: "invalid-request",
      request_id: "req-623",
    };
    assert.equal(startBannerMessage(problem), MANUAL_START_BAD_INPUT_MESSAGE);
    const panel = source("components/workflows/ManualStartPanel.tsx");
    assert.match(
      panel,
      /<ProblemBanner\s+problem=\{problem\}\s+message=\{problemFromStart \? startBannerMessage\(problem\) : null\}/,
    );
    assert.doesNotMatch(panel, /startFailureMessage/);
    const banner = source("components/ProblemBanner.tsx");
    assert.match(banner, /\{message \?/);
    assert.doesNotMatch(banner, /CSRF fail-closed|>\s*request_id|problem\.code|problem\.status|<dl\b/);
    assert.match(banner, /<RequestReference id=\{problem\.request_id\}/);
  });

  it("gives the banner a Start sentence only for 400 and 409, by status and code", () => {
    const base = {
      type: "urn:flowforge:problem:x",
      title: "t",
      detail: "d",
      instance: "/workflows/w/executions",
      request_id: "req-623",
    };
    assert.equal(
      startBannerMessage({ ...base, status: 400, code: "invalid-request" }),
      MANUAL_START_BAD_INPUT_MESSAGE,
    );
    assert.equal(
      startBannerMessage({ ...base, status: 409, code: "conflict" }),
      MANUAL_START_CONFLICT_MESSAGE,
    );
    // Session, CSRF and permission failures keep the banner's own treatment.
    const stale = { ...base, status: 401, code: SESSION_PROBLEM_CODES.unauthenticated };
    assert.equal(startBannerMessage(stale), null);
    assert.ok(isStaleSessionProblem(stale), "a 401 Start failure still gets the sign-in link");
    assert.equal(startBannerMessage({ ...base, status: 401, code: SESSION_PROBLEM_CODES.staleSession }), null);
    assert.equal(startBannerMessage({ ...base, status: 403, code: "forbidden" }), null);
    assert.equal(startBannerMessage({ ...base, status: 403, code: SESSION_PROBLEM_CODES.csrfRequired }), null);
    assert.equal(startBannerMessage({ ...base, status: 400, code: SESSION_PROBLEM_CODES.csrfInvalid }), null);
    assert.equal(startBannerMessage({ ...base, status: 500, code: "internal" }), null);
    assert.equal(startBannerMessage(null), null);
    // Wording never decides: the same status and code give the same answer
    // whatever the title or detail say.
    assert.equal(
      startBannerMessage({
        ...base,
        status: 400,
        code: "invalid-request",
        title: "Unauthorized",
        detail: "session expired",
      }),
      MANUAL_START_BAD_INPUT_MESSAGE,
    );
    const fn = source("lib/manual-start-contract.ts").match(
      /export function startBannerMessage[\s\S]*?\n}\n/,
    )?.[0];
    assert.ok(fn, "startBannerMessage is defined");
    assert.doesNotMatch(fn, /\.(title|detail)\b/);
  });

  it("keeps every user-facing constant on these surfaces free of developer wording", () => {
    const copy: Record<string, string> = {
      CONFIG_PAGE_HELP,
      CONFIG_KIND_PAGE_HELP,
      CLUSTER: configKindPageHelp("cluster_target"),
      SSH: configKindPageHelp("ssh_target"),
      COMMAND: configKindPageHelp("command_profile"),
      POLICY: configKindPageHelp("policy"),
      ...Object.fromEntries(
        Object.entries(CONFIG_LIST_EXTRA_HELP).map(([kind, text]) => [`LIST_${kind}`, text ?? ""]),
      ),
      CONFIG_LIST_PROBLEM_HELP,
      CONFIG_PICKER_HELP,
      CONFIG_PICKER_EMPTY_OPTION,
      CONFIG_DRAFT_HELP,
      CONFIG_VERSION_PAGE_HELP,
      CONFIG_EDIT_PAGE_HELP,
      CONFIG_NEW_PAGE_HELP,
      ROLE_TEMPLATE: kubernetesRoleTemplateHelp("edit"),
      COMMAND_PROFILE_RETRY_SAFE_HELP,
      COMMAND_PROFILE_RETRY_SAFE_UNAVAILABLE,
      COMMAND_PROFILE_RETRY_NOTE,
      COMMAND_PROFILE_PROBE_HELP,
      COMMAND_PROFILE_PROBE_INVALID,
      CREDENTIAL_PICKER_HELP,
      CREDENTIAL_PICKER_KUBERNETES_HELP,
      CREDENTIAL_PICKER_SSH_HELP,
      CREDENTIAL_PICKER_PROBLEM,
      SCRIPT_RUNTIME_DIGEST_HELP,
      SCRIPT_RUNTIME_EGRESS_HELP,
      SCRIPT_RUNTIME_PROFILE_REQUIRED_HELP,
      POLICY_PUBLISH_GAP:
        kubernetesPolicyPublishGap({
          allowedNamespaces: [],
          allowedKinds: [],
          allowedVerbs: [],
          requireApproval: false,
          operations: [],
        }) ?? "",
      ...Object.fromEntries(
        kubernetesPolicyGaps({
          allowedNamespaces: [],
          allowedKinds: [],
          allowedVerbs: [],
          requireApproval: true,
          operations: [],
          deny: true,
        }).map((gap, index) => [`POLICY_GAP_${index}`, gap]),
      ),
      OPS_CONFIG_SELECT_FORBIDDEN,
      OPS_CONFIG_SELECT_NOT_FOUND,
      OPS_CONFIG_SELECT_SIGNED_OUT,
      OPS_CONFIG_SELECT_FAILED,
      OPS_CONFIG_SELECT_EMPTY,
      ALERTS_PAGE_HELP,
      ALERT_DETAIL_PAGE_HELP,
      ALERTS_EMPTY_MESSAGE,
      ALERTS_VIEW_DENIED,
      ALERT_NO_DETAILS,
      ALERT_ACK_UNAVAILABLE,
      ALERT_ACK_APPLIED_MESSAGE,
      ALERT_ACK_IDEMPOTENT_MESSAGE,
      ALERT_ACK_FORBIDDEN_MESSAGE,
      AUDIT_PAGE_HELP,
      AUDIT_APPEND_ONLY_HELP,
      AUDIT_EMPTY_MESSAGE,
      AUDIT_VIEW_DENIED,
      CREDENTIAL_VAULT_PAGE_HELP,
      CREDENTIAL_NEW_PAGE_HELP,
      CREDENTIAL_NDV_ADD_WIZARD_HELP,
      CREDENTIAL_DETAIL_PAGE_HELP,
      CREDENTIAL_VAULT_HELP,
      CREDENTIAL_VAULT_KEYBOARD_HELP,
      CREDENTIAL_VIEW_DENIED,
      CREDENTIAL_VAULT_STRIP_STOP_HELP,
      CREDENTIAL_HIDDEN_FIELDS_LABEL,
      CREDENTIAL_DETAIL_HELP,
      CREDENTIAL_DETAIL_ROTATE_HELP,
      CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP,
      CREDENTIAL_DETAIL_VIEW_DENIED,
      CREDENTIAL_METADATA_HELP,
      CREDENTIAL_EVENTS_HELP,
      CREDENTIAL_TEST_HELP,
      CREDENTIAL_DELETE_HELP,
      PROBLEM_CSRF_HEADING,
      PROBLEM_CSRF_HELP,
      PROBLEM_STALE_SESSION_HELP,
      PROBLEM_HEADING_BAD_REQUEST,
      PROBLEM_HEADING_UNAUTHENTICATED,
      PROBLEM_HEADING_FORBIDDEN,
      PROBLEM_HEADING_NOT_FOUND,
      PROBLEM_HEADING_CONFLICT,
      PROBLEM_HEADING_RATE_LIMITED,
      PROBLEM_HEADING_UNREACHABLE,
      PROBLEM_HEADING_SERVER,
      PROBLEM_SENSITIVE_DETAIL,
      EMBED_CHROME_MISSING_SESSION_MESSAGE,
      EMBED_HOST_DISPLAY_HELP,
      EMBED_URL_SECRET_MESSAGE,
      EMBED_LOCKED_MESSAGE,
      EMBED_HOST_MISMATCH_MESSAGE,
      EMBED_TENANCY_MISMATCH_MESSAGE,
      SESSION_EMBED_WAITING_HELP,
      PORTAL_HELP,
      PORTAL_BOUNDARY_HELP,
      PORTAL_RBAC_HELP,
      PORTAL_TENANCY_HELP,
      PORTAL_ASSERTION_HELP,
      PORTAL_SETTINGS_LOADED,
      PORTAL_SETTINGS_UNAVAILABLE,
      PORTAL_TOKEN_CREATED,
      PORTAL_TOKEN_DELIVERED,
      PORTAL_TOKEN_SKIPPED,
      PORTAL_NOT_MOUNTED_HELP,
      PORTAL_ADMIN_NOT_MEMBER_HELP,
      PORTAL_DENIED_MESSAGE,
      PORTAL_HOSTILE_ISSUER_MESSAGE,
      PORTAL_REPLAY_MESSAGE,
    };
    for (const [name, text] of Object.entries(copy)) {
      assert.ok(text.length > 0, name);
      assert.doesNotMatch(text, DEVELOPER_COPY, name);
    }
  });

  it("renders no developer wording, <code>, or native title tooltip on any of these surfaces", () => {
    for (const relative of SURFACES) {
      const text = source(relative);
      assert.deepEqual(nativeTitleAttributes(text), [], relative);
      assert.doesNotMatch(text, /<code\b/, relative);
      for (const literal of renderedLiterals(text)) {
        assert.doesNotMatch(literal, DEVELOPER_COPY, `${relative}: ${literal}`);
      }
    }
  });

  it("renders no contract notes on these surfaces", () => {
    const contractNotes = [
      "CONFIG_CONTRACT_NOTE",
      "PROBLEM_BANNER_CONTRACT_NOTE",
      "AUDIT_NOT_ISOLATION_HELP",
      "ALERT_ACK_CSRF_HELP",
      "ALERT_SECRET_FREE_HELP",
      "CREDENTIAL_VAULT_CONTRACT_NOTE",
      "CREDENTIAL_DETAIL_CONTRACT_NOTE",
      "CREDENTIAL_KEK_CONTRACT",
      "SCRIPT_EXECUTE_CONTRACT_NOTE",
      "SCRIPT_REVOKE_CONTRACT_NOTE",
      "EMBED_CHROME_MISSING_SESSION_CONTRACT_NOTE",
      "EMBED_HOST_DISPLAY_CONTRACT_NOTE",
      "EMBED_URL_SECRET_CONTRACT_NOTE",
      "EMBED_TENANCY_MISMATCH_CONTRACT_NOTE",
      "SESSION_EMBED_CHROME_HELP",
      "REWRITE_EMBED_MOUNT_HELP",
      "PORTAL_FLOW_CONTRACT_NOTE",
      "PORTAL_ASSERTION_CONTRACT_NOTE",
      "PORTAL_CHIPS_HELP",
    ];
    for (const relative of SURFACES) {
      const text = source(relative);
      for (const note of contractNotes) {
        assert.equal(text.includes(note), false, `${relative} renders ${note}`);
      }
    }
  });

  it("drops the tracker eyebrows from the config, credentials, alerts, and audit headers", () => {
    for (const relative of [
      "app/config/page.tsx",
      "app/config/[kind]/page.tsx",
      "app/config/[kind]/new/page.tsx",
      "app/config/[kind]/[id]/page.tsx",
      "app/config/[kind]/[id]/versions/[versionId]/page.tsx",
      "app/credentials/page.tsx",
      "app/credentials/new/page.tsx",
      "app/credentials/[id]/page.tsx",
      "app/alerts/page.tsx",
      "app/alerts/[id]/page.tsx",
      "app/audit/page.tsx",
    ]) {
      assert.doesNotMatch(source(relative), /Chloe UI|E4\.2|E5\.4|E6\.3|E7\.1|E8\.1|R5\.[12]|EYEBROW/, relative);
    }
    assert.match(source("app/config/page.tsx"), /\{CONFIG_PAGE_HELP\}/);
    assert.match(source("app/alerts/page.tsx"), /\{ALERTS_PAGE_HELP\}/);
    assert.match(source("app/audit/page.tsx"), /\{AUDIT_PAGE_HELP\}/);
    assert.match(source("app/credentials/page.tsx"), /\{CREDENTIAL_VAULT_PAGE_HELP\}/);
    assert.match(source("app/credentials/[id]/page.tsx"), /\{CREDENTIAL_DETAIL_PAGE_HELP\}/);
  });

  it("prints a request id only as a reference on the surfaces that used to say last request_id", () => {
    for (const relative of [
      ...SURFACES,
      "components/config/ConfigKindList.tsx",
      "components/executions/ExecutionHistory.tsx",
      "components/executions/ExecutionDetail.tsx",
      "components/membership/MembershipOperator.tsx",
      "components/workflows/WorkflowOperator.tsx",
    ]) {
      const text = source(relative);
      assert.doesNotMatch(text, /last request_id|request_id \{|>\s*request_id/, relative);
    }
    for (const relative of [
      "components/config/ConfigKindList.tsx",
      "components/config/ConfigDraftEditor.tsx",
      "components/config/ConfigPublishedDetail.tsx",
      "components/credentials/CredentialVault.tsx",
      "components/alerts/AlertList.tsx",
      "components/audit/AuditBrowser.tsx",
    ]) {
      assert.match(source(relative), /<RequestReference\b/, relative);
    }
  });
});
