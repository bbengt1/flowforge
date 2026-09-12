/**
 * R6.2 home activation client — compose existing E10 lists.
 *
 * Relates to #271 / Part of #232. Keep #271 open.
 *
 * Inherits the Gracie + jonny R6 confirmation (D2 compose, D3
 * workflow-level, drafts never look live). No new activation
 * collection. jonny: no list-projection gap — GET /workflows has no
 * computed activation field, so the UI joins the same version +
 * webhook + schedule lists R6.1 already uses. Do not invent a
 * resource.
 */

import { loadEditorActivation } from "./editor-activation-client.ts";
import {
  composeHomeActivation,
  homeActivationFromEditorState,
  homeActivationFromListHint,
  homeActivationNeedsTriggerJoin,
  type HomeActivationColumn,
  type HomeActivationListHint,
} from "./home-activation.ts";
import type { DevIdentity } from "./identity-headers.ts";

export async function loadHomeActivation(
  identity: DevIdentity,
  record: HomeActivationListHint,
  options: { canView?: boolean } = {},
): Promise<HomeActivationColumn> {
  const canView = options.canView !== false;
  if (!canView) {
    return homeActivationFromListHint(record);
  }
  if (!homeActivationNeedsTriggerJoin(record)) {
    return composeHomeActivation({
      workflowId: record.id,
      latestVersionNumber: record.latestVersionNumber,
      latestVersionId: record.latestVersionId,
    });
  }
  const loaded = await loadEditorActivation(identity, record.id, { canView });
  return homeActivationFromEditorState(
    record.id,
    loaded.state,
    loaded.ok,
    record,
  );
}

export async function loadHomeActivationStates(
  identity: DevIdentity,
  records: readonly HomeActivationListHint[],
  options: { canView?: boolean } = {},
): Promise<Map<string, HomeActivationColumn>> {
  const entries = await Promise.all(
    records.map(async (record) => {
      const column = await loadHomeActivation(identity, record, options);
      return [record.id, column] as const;
    }),
  );
  return new Map(entries);
}
