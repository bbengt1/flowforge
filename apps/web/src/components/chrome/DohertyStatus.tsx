import {
  dohertyChromeLabel,
  dohertyStatusClassName,
  dohertyStatusRole,
  type DohertyChrome,
} from "@/lib/doherty-pending-chrome";

type DohertyStatusProps = {
  chrome: DohertyChrome;
  className?: string;
};

export function DohertyStatus({ chrome, className }: DohertyStatusProps) {
  const label = dohertyChromeLabel(chrome);
  if (!label || !chrome.gesture) {
    return null;
  }
  const role = dohertyStatusRole(chrome.phase);
  return (
    <p
      role={role}
      data-doherty-chrome={chrome.gesture}
      data-doherty-phase={chrome.phase}
      aria-busy={chrome.phase === "pending" ? true : undefined}
      className={`${dohertyStatusClassName(chrome.phase)}${className ? ` ${className}` : ""}`}
    >
      {label}
    </p>
  );
}
