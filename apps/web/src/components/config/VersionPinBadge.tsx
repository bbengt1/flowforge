import { versionPinLabel } from "@/lib/ops-config";

type VersionPinBadgeProps = {
  displayName?: string;
  name?: string;
  versionNumber?: number;
  digest?: string;
  readOnly?: boolean;
};

export function VersionPinBadge({
  displayName,
  name,
  versionNumber,
  digest,
  readOnly,
}: VersionPinBadgeProps) {
  const label = versionPinLabel({ displayName, name, versionNumber, digest });
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 font-mono text-xs ${
        readOnly
          ? "bg-zinc-100 text-zinc-700"
          : "bg-teal-50 text-teal-950"
      }`}
    >
      {label}
      {readOnly ? <span className="font-sans text-[10px] uppercase">read-only</span> : null}
    </span>
  );
}
