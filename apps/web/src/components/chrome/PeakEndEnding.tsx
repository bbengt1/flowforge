import {
  peakEndLabel,
  peakEndTextClassName,
  type PeakEndKind,
} from "@/lib/peak-end-operate-endings";

type PeakEndEndingProps = {
  kind: PeakEndKind;
  surface?: "overlay" | "inbox" | "ndv";
  className?: string;
};

export function PeakEndEnding({
  kind,
  surface = "overlay",
  className,
}: PeakEndEndingProps) {
  const label = peakEndLabel(kind, surface);
  if (!label) {
    return null;
  }
  return (
    <p
      role="status"
      data-peak-end={kind}
      data-peak-end-surface={surface}
      className={`text-xs font-medium ${peakEndTextClassName(kind)}${className ? ` ${className}` : ""}`}
    >
      {label}
    </p>
  );
}
