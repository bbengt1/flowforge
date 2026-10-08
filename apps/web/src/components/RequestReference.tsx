import { REQUEST_REFERENCE_LABEL, requestReference } from "@/lib/request-reference";

type RequestReferenceProps = {
  id: string | null | undefined;
  className?: string;
};

/** "Reference: <id>" for support, in small muted text. Renders nothing without an id. */
export function RequestReference({ id, className }: RequestReferenceProps) {
  const reference = requestReference(id);
  if (!reference) {
    return null;
  }
  return (
    <p className={className ?? "text-xs text-fg/80"}>
      {REQUEST_REFERENCE_LABEL}: <span className="break-all font-mono">{reference}</span>
    </p>
  );
}
