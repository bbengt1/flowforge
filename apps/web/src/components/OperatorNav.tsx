"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import { canSeeApprovalsNav } from "@/lib/approval";
import { canSeeOpsConfigNav } from "@/lib/ops-config";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const linkClass =
  "text-sm text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 hover:decoration-zinc-600";

type OperatorNavProps = {
  swaggerUrl: string;
};

export function OperatorNav({ swaggerUrl }: OperatorNavProps) {
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
      <Link href="/membership" className={linkClass}>
        Membership
      </Link>
      <Link href="/isolation" className={linkClass}>
        Isolation
      </Link>
      <a className={linkClass} href={swaggerUrl}>
        OpenAPI / Swagger
      </a>
    </nav>
  );
}
