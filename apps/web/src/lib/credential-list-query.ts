/**
 * One shared read of the workspace credential list per page (#634 F5).
 *
 * The search bar and the editor's credential pickers all need GET
 * /credentials. They read it through one TanStack Query key, so a page
 * load sends one request. That background read is quiet: a 403
 * `mfa-required` comes back as a result and does not open the step-up
 * dialog. Step-up opens only when the person asks for the list, through
 * a loud read (`loud: true`).
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  listCredentials,
  type CredentialClientFailure,
  type CredentialListSuccess,
} from "./credential-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { isMfaRequiredProblem } from "./oidc-mfa.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  credentialListQueryKey,
  sanitizeQueryCacheValue,
  tryQueryScope,
} from "./query-cache.ts";

/** Contract note for route checks. Not UI copy: never render it. */
export const CREDENTIAL_LIST_QUERY_CONTRACT_NOTE =
  "GET /credentials is shared under one query key per workspace scope. Background reads pass quietMfa so 403 mfa-required does not open step-up; a person's own Load action reads loudly and may open step-up. Status and code decide, never message text.";

/** How long a background read is reused before another request is sent. */
export const CREDENTIAL_LIST_STALE_MS = 10_000;

export type CredentialListResult = CredentialListSuccess | CredentialClientFailure;

type ListFn = typeof listCredentials;

/**
 * Read the shared credential list. Background reads (`loud` false) reuse a
 * fresh or in-flight result and never open step-up. A loud read always
 * goes to the server and lets a 403 mfa-required open step-up.
 */
export async function fetchSharedCredentialList(
  client: QueryClient,
  identity: DevIdentity,
  options: { loud?: boolean; fresh?: boolean; list?: ListFn } = {},
): Promise<CredentialListResult> {
  const list = options.list ?? listCredentials;
  const loud = options.loud === true;
  const scope = tryQueryScope(identity);
  const key = scope == null ? null : credentialListQueryKey(scope);
  if (!key) {
    return list(identity, {}, loud ? {} : { quietMfa: true });
  }
  if (loud || options.fresh) {
    // A person asked, or a credential was just added: drop the cached
    // result and read again.
    client.removeQueries({ queryKey: key, exact: true });
  }
  return client.fetchQuery({
    queryKey: key,
    // Failures are kept as results so a refused read is not retried at once.
    retry: false,
    staleTime: loud || options.fresh ? 0 : CREDENTIAL_LIST_STALE_MS,
    queryFn: async () => {
      const result = await list(identity, {}, loud ? {} : { quietMfa: true });
      // Cached values are stripped before they are stored (query-cache.ts).
      return result.ok
        ? { ...result, items: sanitizeQueryCacheValue(result.items).value }
        : result;
    },
  });
}

/** The quiet read was refused only because MFA step-up is needed. */
export function credentialListNeedsStepUp(
  problem: Pick<ProblemDetails, "status" | "code"> | null | undefined,
): boolean {
  return isMfaRequiredProblem(problem);
}
