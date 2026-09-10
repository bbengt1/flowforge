"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import { canSeeAlertsNav, canSeeAuditNav } from "@/lib/alert";
import { canSeeApprovalsNav } from "@/lib/approval";
import { canSeeExecutionsNav } from "@/lib/execution";
import { canSeeOpsConfigNav } from "@/lib/ops-config";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const linkClass =
  "text-sm text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 hover:decoration-zinc-600";

export function OperatorNav() {
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );
  const [permissions, setPermissions] = useState<string[] | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void callIdentityProxy<CurrentWorkspace>("/workspace", identity).then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setPermissions(result.data.permissions ?? []);
          return;
        }
        if (result.statusCode === 403 || result.statusCode === 401) {
          setPermissions([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, identity]);

  const showConfig = canSeeOpsConfigNav(ready ? permissions : null);
  const showApprovals = canSeeApprovalsNav(ready ? permissions : null);
  const showExecutions = canSeeExecutionsNav(ready ? permissions : null);
  const showAlerts = canSeeAlertsNav(ready ? permissions : null);
  const showAudit = canSeeAuditNav(ready ? permissions : null);

  return (
    <nav aria-label="Operator" className="flex flex-wrap items-center gap-4">
      <SessionStatusChip />
      <Link href="/workflows" className={linkClass}>
        Workflows
      </Link>
      <Link href="/credentials" className={linkClass}>
        Credentials
      </Link>
      {showConfig ? (
        <>
          <Link href="/config?group=targets" className={linkClass}>
            Targets
          </Link>
          <Link href="/config?group=profiles" className={linkClass}>
            Profiles
          </Link>
          <Link href="/config?group=config" className={linkClass}>
            Config
          </Link>
        </>
      ) : null}
      {showApprovals ? (
        <Link href="/approvals" className={linkClass}>
          Approvals
        </Link>
      ) : null}
      {showExecutions ? (
        <Link href="/executions" className={linkClass}>
          Executions
        </Link>
      ) : null}
      {showAlerts ? (
        <Link href="/alerts" className={linkClass}>
          Alerts
        </Link>
      ) : null}
      {showAudit ? (
        <Link href="/audit" className={linkClass}>
          Audit
        </Link>
      ) : null}
      <Link href="/membership" className={linkClass}>
        Membership
      </Link>
      <Link href="/isolation" className={linkClass}>
        Isolation
      </Link>
      <Link href="/settings" className={linkClass}>
        Health / OpenAPI
      </Link>
    </nav>
  );
}
