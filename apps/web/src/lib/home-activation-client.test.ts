import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyStoredIdentity } from "./dev-identity.ts";
import { HOME_ACTIVATION_DRAFT_LABEL } from "./home-activation.ts";
import { loadHomeActivation, loadHomeActivationStates } from "./home-activation-client.ts";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

describe("R6.2 home activation client", () => {
  it("short-circuits unpublished rows so drafts never look live", async () => {
    const identity = emptyStoredIdentity();
    const column = await loadHomeActivation(identity, {
      id: DRAFT_ID,
      latestVersionNumber: 0,
    });
    assert.equal(column.kind, "no-published");
    assert.equal(column.live, false);
    assert.equal(column.draftLooksLive, false);
    assert.equal(column.label, HOME_ACTIVATION_DRAFT_LABEL);
    assert.equal(column.href, `/workflows/${DRAFT_ID}#activation`);

    const hidden = await loadHomeActivation(
      identity,
      { id: DRAFT_ID, latestVersionNumber: 2, latestVersionId: DRAFT_ID },
      { canView: false },
    );
    assert.equal(hidden.live, false);
    assert.equal(hidden.draftLooksLive, false);
    assert.equal(hidden.kind, "unknown");

    const map = await loadHomeActivationStates(identity, [
      { id: DRAFT_ID, latestVersionNumber: 0 },
    ]);
    assert.equal(map.get(DRAFT_ID)?.label, HOME_ACTIVATION_DRAFT_LABEL);
  });
});
