package approvalhttp

import (
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
)

// listApproverCandidates serves the builder picker: active members who
// may decide for role, and every workspace group. Machine principals are
// never candidates; groups are listed as they are (their machine members
// never count). Display name and id only.
func listApproverCandidates(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		core.WriteForbidden(w, r)
		return
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	role := strings.TrimSpace(r.URL.Query().Get("role"))
	if role == "" || !authz.KnownRole(role) {
		core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "role must be a known role key.",
			[]core.FieldError{{Path: "role", Code: "invalid-role", Message: "role must be a known role key."}})
		return
	}
	q, ok := candidateQuery(w, r)
	if !ok {
		return
	}
	members, err := s.Store.ListMembers(r.Context(), ws.ID)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return
	}
	out := candidateList{Users: []approval.PrincipalRef{}, Groups: []approval.PrincipalRef{}}
	for _, m := range members {
		if (m.User.Status != "" && m.User.Status != "active") || parkedapproval.IsMachine(m.User.Issuer) {
			continue
		}
		if !authz.Allows(authz.ExpandWorkspaceRoles(m.Roles), authz.PermApprovalDecide) || !approval.HasApproverRole(m.Roles, role) {
			continue
		}
		if !q.matches(m.User.DisplayName) {
			continue
		}
		out.Users = append(out.Users, approval.PrincipalRef{ID: m.User.ID, DisplayName: m.User.DisplayName})
	}
	if gs, ok := s.Store.(identity.GroupStore); ok {
		groups, _, err := gs.ListGroupsPage(r.Context(), ws.ID, page.Query{})
		if err != nil {
			core.WriteIdentityError(w, r, err)
			return
		}
		for _, g := range groups {
			if !q.matches(g.DisplayName) {
				continue
			}
			out.Groups = append(out.Groups, approval.PrincipalRef{ID: g.ID, DisplayName: g.DisplayName})
		}
	}
	sortRefs(out.Users)
	sortRefs(out.Groups)
	core.WriteJSON(w, http.StatusOK, out)
}

type candidateList struct {
	Users  []approval.PrincipalRef `json:"users"`
	Groups []approval.PrincipalRef `json:"groups"`
}

func sortRefs(refs []approval.PrincipalRef) {
	sort.SliceStable(refs, func(i, j int) bool {
		if refs[i].DisplayName != refs[j].DisplayName {
			return refs[i].DisplayName < refs[j].DisplayName
		}
		return refs[i].ID < refs[j].ID
	})
}

// maxCandidateQuery caps q (after trimming) in characters.
const maxCandidateQuery = 100

// candidateFilter is the optional q narrowing (#646). It runs after the
// permission gate and over the workspace-scoped rows the unfiltered list
// would return, so q only ever narrows. It matches display name only,
// never email or username, as a case-insensitive substring. The match is
// literal: q is never a pattern, so %, _ and \ match only themselves.
// The handler does this for every store, so memory and Postgres agree.
type candidateFilter struct{ needle string }

func candidateQuery(w http.ResponseWriter, r *http.Request) (candidateFilter, bool) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > maxCandidateQuery {
		core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "q must be at most 100 characters.",
			[]core.FieldError{{Path: "q", Code: "invalid-query", Message: "q must be at most 100 characters."}})
		return candidateFilter{}, false
	}
	return candidateFilter{needle: foldCase(q)}, true
}

func (f candidateFilter) matches(displayName string) bool {
	return f.needle == "" || strings.Contains(foldCase(displayName), f.needle)
}

func foldCase(s string) string { return strings.ToLower(strings.ToUpper(s)) }
