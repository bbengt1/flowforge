"use client";

import { KubernetesLeastPrivilegeNotes } from "@/components/config/KubernetesLeastPrivilegeNotes";
import {
  KUBERNETES_APPROVAL_HELP,
  KUBERNETES_KIND_HELP,
  KUBERNETES_VERB_HELP,
} from "@/lib/kubernetes-contract";
import {
  applyKubernetesPolicyToSpec,
  kubernetesPolicyGaps,
  parseKubernetesPolicy,
} from "@/lib/kubernetes";
import {
  KUBERNETES_ALLOWED_KINDS,
  KUBERNETES_ALLOWED_VERBS,
  KUBERNETES_APPROVAL_OPERATIONS,
  type KubernetesEngineCatalog,
  type KubernetesPolicyBody,
} from "@/lib/kubernetes-types";
import type { OpsConfigSpec } from "@/lib/ops-config-types";

type KubernetesPolicyFormProps = {
  spec: OpsConfigSpec;
  readOnly: boolean;
  engine?: KubernetesEngineCatalog | null;
  extraNotes?: readonly string[];
  onChange: (spec: OpsConfigSpec) => void;
};

export function KubernetesPolicyForm({
  spec,
  readOnly,
  engine,
  extraNotes,
  onChange,
}: KubernetesPolicyFormProps) {
  const policy = parseKubernetesPolicy(spec);
  const gaps = kubernetesPolicyGaps(policy);
  const kinds = engine?.allowedKinds.length
    ? engine.allowedKinds
    : KUBERNETES_ALLOWED_KINDS;
  const verbs = engine?.allowedVerbs.length
    ? engine.allowedVerbs
    : KUBERNETES_ALLOWED_VERBS;
  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50";

  function patch(next: KubernetesPolicyBody) {
    onChange(applyKubernetesPolicyToSpec(spec, next));
  }

  return (
    <div className="grid gap-4">
      <KubernetesLeastPrivilegeNotes extraNotes={extraNotes} />

      <label className="text-sm">
        <span className="font-medium">Allowed namespaces</span>
        <textarea
          value={policy.allowedNamespaces.join("\n")}
          disabled={readOnly}
          rows={3}
          autoComplete="off"
          onChange={(event) =>
            patch({
              ...policy,
              allowedNamespaces: splitLines(event.target.value),
            })
          }
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          One namespace per line. Empty allowlist fails closed.
        </span>
      </label>

      <fieldset className="text-sm">
        <legend className="font-medium">Allowed kinds</legend>
        <p className="mt-1 text-xs text-zinc-500">{KUBERNETES_KIND_HELP}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {kinds.map((kind) => (
            <label key={kind} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.allowedKinds.includes(kind)}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    ...policy,
                    allowedKinds: toggleList(
                      policy.allowedKinds,
                      kind,
                      event.target.checked,
                    ),
                  })
                }
              />
              <span className="font-mono text-xs">{kind}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="text-sm">
        <legend className="font-medium">Allowed verbs</legend>
        <p className="mt-1 text-xs text-zinc-500">{KUBERNETES_VERB_HELP}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {verbs.map((verb) => (
            <label key={verb} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.allowedVerbs.includes(verb)}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    ...policy,
                    allowedVerbs: toggleList(
                      policy.allowedVerbs,
                      verb,
                      event.target.checked,
                    ),
                  })
                }
              />
              <span className="font-mono text-xs">{verb}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={policy.requireApproval}
          disabled={readOnly}
          onChange={(event) =>
            patch({ ...policy, requireApproval: event.target.checked })
          }
        />
        Approval required for listed operations
      </label>

      <fieldset className="text-sm">
        <legend className="font-medium">Approval-required actions</legend>
        <p className="mt-1 text-xs text-zinc-500">{KUBERNETES_APPROVAL_HELP}</p>
        <div className="mt-2 grid gap-2">
          {KUBERNETES_APPROVAL_OPERATIONS.map((operation) => (
            <label key={operation} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.operations.includes(operation)}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    ...policy,
                    operations: toggleList(
                      policy.operations,
                      operation,
                      event.target.checked,
                    ),
                  })
                }
              />
              <span className="font-mono text-xs">{operation}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="font-medium">Approver role</span>
          <input
            value={policy.approverRole ?? ""}
            disabled={readOnly}
            autoComplete="off"
            onChange={(event) =>
              patch({ ...policy, approverRole: event.target.value })
            }
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="font-medium">Approval expiry (ISO-8601)</span>
          <input
            value={policy.expiresIn ?? ""}
            disabled={readOnly}
            autoComplete="off"
            placeholder="PT1H"
            onChange={(event) =>
              patch({ ...policy, expiresIn: event.target.value })
            }
            className={inputClass}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={policy.deny === true}
          disabled={readOnly}
          onChange={(event) => patch({ ...policy, deny: event.target.checked })}
        />
        Deny all matching operations (fail closed)
      </label>

      {gaps.length > 0 ? (
        <ul className="space-y-1 text-sm text-amber-900" role="status">
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toggleList(values: string[], item: string, on: boolean): string[] {
  if (on) {
    return values.includes(item) ? values : [...values, item];
  }
  return values.filter((value) => value !== item);
}
