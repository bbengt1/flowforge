package scimhttp

import (
	"net/http"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
)

// SCIM_GROUPS_MODE=groups. /Groups maps to Flowforge groups inside the
// workspace of the presented workspace token. The instance token is
// refused on every /Groups call (its /Users handling is unchanged).
// Group member changes write group rows only; workspace membership comes
// only from /Users.

// groupsModeInstanceDetail is the 403 detail for the instance token.
const groupsModeInstanceDetail = "SCIM Groups are managed per workspace on this instance (SCIM_GROUPS_MODE=groups). Use that workspace's SCIM token for /Groups."

// groupsModeScope returns the workspace token scope, or writes 403 for
// the instance token. Call it only after authorizeSCIM accepted.
func groupsModeScope(w http.ResponseWriter, scope *scim.TokenScope) (scim.TokenScope, bool) {
	if scope == nil {
		writeSCIMError(w, http.StatusForbidden, groupsModeInstanceDetail)
		return scim.TokenScope{}, false
	}
	return *scope, true
}

func gmListGroups(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	attr, value, start, count, err := scimPage(r)
	if err != nil || (attr != "" && attr != "displayName" && attr != "externalId" && attr != "id") {
		writeSCIMError(w, http.StatusBadRequest, "The filter is not supported.")
		return
	}
	rows, total, err := s.ScimTokens.ListManagedGroups(r.Context(), scope, attr, value, start, count)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	resources := make([]any, 0, len(rows))
	for _, g := range rows {
		resources = append(resources, scimManagedGroupResource(g))
	}
	writeSCIM(w, http.StatusOK, scimList(resources, start, count, total))
}

func gmGetGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	g, err := s.ScimTokens.GetManagedGroup(r.Context(), scope, r.PathValue("id"))
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimManagedGroupResource(g))
}

func gmPostGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	in, err := scim.ParseManagedGroupWrite(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	g, err := s.ScimTokens.CreateManagedGroup(r.Context(), scope, in, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	w.Header().Set("Location", "/scim/v2/Groups/"+g.ID)
	writeSCIM(w, http.StatusCreated, scimManagedGroupResource(g))
}

func gmPutGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	in, err := scim.ParseManagedGroupWrite(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	g, err := s.ScimTokens.ReplaceManagedGroup(r.Context(), scope, r.PathValue("id"), in, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimManagedGroupResource(g))
}

func gmPatchGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseManagedGroupPatch(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	g, err := s.ScimTokens.PatchManagedGroup(r.Context(), scope, r.PathValue("id"), ch, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimManagedGroupResource(g))
}

func gmDeleteGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	if err := s.ScimTokens.DeleteManagedGroup(r.Context(), scope, r.PathValue("id"), scimActor(r, scope), s.ClockNow()); err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func scimManagedGroupResource(g scim.ManagedGroup) map[string]any {
	items := make([]any, 0, len(g.Members))
	for _, m := range g.Members {
		items = append(items, map[string]any{"value": m.UserID, "display": m.DisplayName})
	}
	body := map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:Group"},
		"id":          g.ID,
		"displayName": g.DisplayName,
		"members":     items,
		"meta": map[string]any{
			"resourceType": "Group",
			"created":      g.CreatedAt.UTC().Format(time.RFC3339),
			"lastModified": g.UpdatedAt.UTC().Format(time.RFC3339),
			"location":     "/scim/v2/Groups/" + g.ID,
		},
	}
	if g.ExternalID != "" {
		body["externalId"] = g.ExternalID
	}
	return body
}
