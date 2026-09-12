"use client";

import Link from "next/link";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { canSeeAuditNav } from "@/lib/alert";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";
import {
  ISOLATION_CHECK_HELP,
  ISOLATION_CHECK_HREF,
  MEMBERSHIP_ADMIN_HELP,
  MEMBERSHIP_ADMIN_HREF,
  SETTINGS_ADMIN_LINKS_HELP,
  settingsMayLinkMembershipIsolation,
} from "@/lib/membership-isolation-chrome";

export function FoundationAdminLinks() {
  const embed = useEmbedMode();
  const { permissions } = useWorkspace();
  const showAdmin = settingsMayLinkMembershipIsolation(permissions);
  const showAudit = canSeeAuditNav(permissions);
  if (!showAdmin && !showAudit) {
    return null;
  }

  const membershipHref = embed
    ? embedDeepLink(MEMBERSHIP_ADMIN_HREF)
    : MEMBERSHIP_ADMIN_HREF;
  const isolationHref = embed
    ? embedDeepLink(ISOLATION_CHECK_HREF)
    : ISOLATION_CHECK_HREF;
  const auditHref = embed ? embedDeepLink("/audit") : "/audit";

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Workspace administration</h2>
      <p className="mt-1 text-sm text-zinc-600">{SETTINGS_ADMIN_LINKS_HELP}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {showAdmin ? (
          <>
            <li>
              <Link href={membershipHref} className="text-teal-800 underline">
                Workspace members
              </Link>
              <span className="text-zinc-600"> — {MEMBERSHIP_ADMIN_HELP}</span>
            </li>
            <li>
              <Link href={isolationHref} className="text-teal-800 underline">
                Isolation check
              </Link>
              <span className="text-zinc-600"> — {ISOLATION_CHECK_HELP}</span>
            </li>
          </>
        ) : null}
        {showAudit ? (
          <li>
            <Link href={auditHref} className="text-teal-800 underline">
              Workspace audit
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
