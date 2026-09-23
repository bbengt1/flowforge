import Link from "next/link";
import { SETTINGS_SESSION_HREF } from "@/lib/product-session-chrome";

type SessionSetupHintProps = {
  /** Trailing clause after the Settings link. */
  purpose?: string;
};

export function SessionSetupHint({
  purpose = "before using this surface.",
}: SessionSetupHintProps) {
  return (
    <p className="text-sm text-fg">
      Establish a cookie session and tenant + workbench in{" "}
      <Link
        href={SETTINGS_SESSION_HREF}
        className="font-medium text-fg underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
      >
        Settings
      </Link>{" "}
      {purpose}
    </p>
  );
}
