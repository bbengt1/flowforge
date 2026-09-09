/**
 * Typed E8.1 catalog client. Paths come from ssh-contract.ts so a
 * retarget only edits that adapter. GET /ssh/catalog does not open
 * an SSH connection. Session cookies. Specs are secret-stripped.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { sshCatalogPath } from "./ssh-contract.ts";
import { parseSshNodeCatalog, type SshNodeCatalog } from "./ssh-node-contract.ts";
import { parseSshEngineCatalog } from "./ssh.ts";
import type { SshEngineCatalog } from "./ssh-types.ts";
import type { ProblemDetails } from "./problem.ts";

export type SshCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: SshEngineCatalog;
  nodeCatalog: SshNodeCatalog;
};

export type SshClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export async function getSshCatalog(
  identity: DevIdentity,
): Promise<SshCatalogSuccess | SshClientFailure> {
  const result = await callIdentityProxy<unknown>(sshCatalogPath(), identity);
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: result.problem,
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: parseSshEngineCatalog(result.data),
    nodeCatalog: parseSshNodeCatalog(result.data),
  };
}
