import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import type { OpsConfigPin } from "@/lib/ops-config-types";

type ConfigPinListProps = {
  pins: OpsConfigPin[] | undefined;
  empty?: string;
};

export function ConfigPinList({ pins, empty }: ConfigPinListProps) {
  if (!pins || pins.length === 0) {
    return empty ? <p className="text-xs text-zinc-500">{empty}</p> : null;
  }
  return (
    <ul className="space-y-1">
      {pins.map((pin) => (
        <li key={`${pin.kind}:${pin.resourceId}:${pin.versionId}`}>
          <VersionPinBadge
            name={pin.name}
            versionNumber={pin.versionNumber}
            digest={pin.digest}
            readOnly
          />
          <p className="font-mono text-[11px] break-all text-zinc-500">
            {pin.kind} {pin.resourceId}
          </p>
        </li>
      ))}
    </ul>
  );
}
