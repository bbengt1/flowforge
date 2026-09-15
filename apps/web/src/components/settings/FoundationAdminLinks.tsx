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
import {
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

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
    <section className={FF_SETTINGS_PANEL_CLASS}>
      <h2 className={`text-base ${FF_SETTINGS_TITLE_CLASS}`}>Workspace administration</h2>
      <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>{SETTINGS_ADMIN_LINKS_HELP}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {showAdmin ? (
          <>
            <li>
              <Link href={membershipHref} className={FF_SETTINGS_LINK_CLASS}>
                Workspace members
              </Link>
              <span className={FF_SETTINGS_MUTED_CLASS}> — {MEMBERSHIP_ADMIN_HELP}</span>
            </li>
            <li>
              <Link href={isolationHref} className={FF_SETTINGS_LINK_CLASS}>
                Isolation check
              </Link>
              <span className={FF_SETTINGS_MUTED_CLASS}> — {ISOLATION_CHECK_HELP}</span>
            </li>
          </>
        ) : null}
        {showAudit ? (
          <li>
            <Link href={auditHref} className={FF_SETTINGS_LINK_CLASS}>
              Workspace audit
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
