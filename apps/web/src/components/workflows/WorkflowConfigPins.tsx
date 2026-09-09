"use client";

import { useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import type { DevIdentity } from "@/lib/identity-headers";
import { listAuthorizedPins } from "@/lib/ops-config-client";
import { OPS_CONFIG_KIND_CATALOG } from "@/lib/ops-config-contract";
import { authorizedSelectorOptions } from "@/lib/ops-config";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";

const PICKER_KINDS: OpsConfigKind[] = [
  "cluster_target",
  "ssh_target",
  "command_profile",
  "runtime_profile",
  "connection",
  "recipient_list",
  "message_template",
  "response_schema",
];

type WorkflowConfigPinsProps = {
  identity: DevIdentity;
  ready: boolean;
};

export function WorkflowConfigPins({ identity, ready }: WorkflowConfigPinsProps) {
  const [kind, setKind] = useState<OpsConfigKind>("cluster_target");
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [selected, setSelected] = useState<OpsConfigPin | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);
  const [pending, setPending] = useState(false);

  async function load(nextKind: OpsConfigKind) {
    setKind(nextKind);
    setSelected(null);
    setPending(true);
    const result = await listAuthorizedPins(identity, nextKind);
    setPending(false);
    setStatusCode(result.statusCode);
    if (!result.ok) {
      setProblem(result.problem);
      setPins([]);
      return;
    }
    setProblem(null);
    setPins(result.items);
  }

  const options = authorizedSelectorOptions({ items: pins, problem, statusCode });

  return (
    <section
      aria-labelledby="config-pins-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="config-pins-heading" className="text-base font-semibold">
        Authorized config pins
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Workflow YAML references UUIDs. This picker lists only
        server-authorized published resources as display name + version.
        Secrets never appear. 403 or empty lists fail closed.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-[16rem_1fr]">
        <label className="text-sm">
          <span className="font-medium">Kind</span>
          <select
            value={kind}
            disabled={!ready || pending}
            onChange={(event) => void load(event.target.value as OpsConfigKind)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
          >
            {OPS_CONFIG_KIND_CATALOG.filter((item) =>
              PICKER_KINDS.includes(item.kind),
            ).map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <AuthorizedResourceSelect
          kind={kind}
          label="Published pin"
          value={selected?.versionId ?? ""}
          pins={options.options}
          problem={problem}
          statusCode={statusCode}
          disabled={!ready || pending}
          onChange={setSelected}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void load(kind)}
          disabled={!ready || pending}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Load authorized pins"}
        </button>
      </div>

      {selected ? (
        <div className="mt-4 space-y-2">
          <VersionPinBadge
            displayName={selected.displayName}
            versionNumber={selected.versionNumber}
            digest={selected.digest}
            readOnly
          />
          <p className="font-mono text-xs break-all text-zinc-500">
            {OPS_CONFIG_KIND_CATALOG.find((item) => item.kind === kind)?.yamlRef}
            : {selected.id}
          </p>
        </div>
      ) : null}
    </section>
  );
}
