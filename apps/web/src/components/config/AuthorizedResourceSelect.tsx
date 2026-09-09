"use client";

import { ProblemBanner } from "@/components/ProblemBanner";
import { authorizedSelectorOptions, selectorOptionLabel } from "@/lib/ops-config";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";

type AuthorizedResourceSelectProps = {
  kind: OpsConfigKind;
  label: string;
  value: string;
  pins: OpsConfigPin[];
  problem: ProblemDetails | null;
  statusCode?: number;
  disabled?: boolean;
  onChange: (pin: OpsConfigPin | null) => void;
};

export function AuthorizedResourceSelect({
  kind,
  label,
  value,
  pins,
  problem,
  statusCode,
  disabled,
  onChange,
}: AuthorizedResourceSelectProps) {
  const selected = authorizedSelectorOptions({
    items: pins,
    problem,
    statusCode,
  });

  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <select
          value={value}
          disabled={disabled || selected.closed}
          onChange={(event) => {
            const next = selected.options.find(
              (item) => item.versionId === event.target.value || item.id === event.target.value,
            );
            onChange(next ?? null);
          }}
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
        >
          <option value="">
            {selected.closed ? "No authorized resources" : "Select a published version"}
          </option>
          {selected.options.map((pin) => (
            <option key={`${pin.id}:${pin.versionId}`} value={pin.versionId}>
              {selectorOptionLabel(pin)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-zinc-500">
        Server-authorized {kind.replaceAll("_", " ")} pins only. Display name +
        version — never secrets.
      </p>
      {problem ? <ProblemBanner problem={problem} /> : null}
      {selected.closed && !problem ? (
        <p role="status" className="text-sm text-zinc-600">
          {selected.reason}
        </p>
      ) : null}
    </div>
  );
}
