package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// candidateQEnv is what the #646 q-filter checks need from a store setup.
// do calls approver-candidates in the home workspace; member and group
// create rows in the home (other=false) or a second workspace (other=true).
type candidateQEnv struct {
	do     func(rawQuery string) *httptest.ResponseRecorder
	member func(other bool, subject, name string) string
	group  func(other bool, name string) string
}

type candidateQBody struct {
	Users  []approval.PrincipalRef `json:"users"`
	Groups []approval.PrincipalRef `json:"groups"`
}

// runCandidateQChecks is shared by the memory and Postgres tests so both
// stores are held to the same behavior.
func runCandidateQChecks(t *testing.T, env candidateQEnv) {
	t.Helper()
	ada := env.member(false, "q646-ada.mail@corp.example", "Ada Lovelace")
	pct := env.member(false, "q646-pct", "100% Sure")
	und := env.member(false, "q646-und", "snake_case")
	bsl := env.member(false, "q646-bsl", `back\slash`)
	// Decoys a wildcard reading of %, _ or \ would also match.
	env.member(false, "q646-plain", "100 x Sure")
	env.member(false, "q646-plainu", "snakeXcase")
	env.member(false, "q646-plainb", "backslash")
	dup1 := env.member(false, "q646-dup1", "Twin")
	dup2 := env.member(false, "q646-dup2", "Twin")
	foreign := env.member(true, "q646-foreign", "Ada Foreign")
	adaGroup := env.group(false, "Ada Group")
	foreignGroup := env.group(true, "Ada Foreign Group")

	get := func(t *testing.T, q string) candidateQBody {
		t.Helper()
		rec := env.do("role=approver&q=" + url.QueryEscape(q))
		if rec.Code != http.StatusOK {
			t.Fatalf("q=%q: %d %s", q, rec.Code, rec.Body.String())
		}
		var b candidateQBody
		if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	ids := func(refs []approval.PrincipalRef) map[string]bool {
		m := map[string]bool{}
		for _, r := range refs {
			m[r.ID] = true
		}
		return m
	}
	exactUsers := func(t *testing.T, q string, want ...string) {
		t.Helper()
		got := ids(get(t, q).Users)
		if len(got) != len(want) {
			t.Fatalf("q=%q users = %v, want %v", q, got, want)
		}
		for _, id := range want {
			if !got[id] {
				t.Fatalf("q=%q users = %v, missing %s", q, got, id)
			}
		}
	}

	t.Run("case-insensitive substring of display name", func(t *testing.T) {
		b := get(t, "  lOVEl  ")
		if len(b.Users) != 1 || b.Users[0].ID != ada || b.Users[0].DisplayName != "Ada Lovelace" || len(b.Groups) != 0 {
			t.Fatalf("got %+v", b)
		}
		if g := ids(get(t, "ada g").Groups); len(g) != 1 || !g[adaGroup] {
			t.Fatalf("groups = %v", g)
		}
	})
	t.Run("percent underscore and backslash are literal", func(t *testing.T) {
		exactUsers(t, "0%", pct)
		exactUsers(t, "%", pct)
		exactUsers(t, "e_c", und)
		exactUsers(t, "_", und)
		exactUsers(t, `k\s`, bsl)
		exactUsers(t, `\`, bsl)
	})
	t.Run("email or username fragment never matches", func(t *testing.T) {
		for _, q := range []string{"corp.example", "ada.mail", "@", "q646-", "https://idp"} {
			if b := get(t, q); len(b.Users) != 0 {
				t.Fatalf("q=%q matched %+v", q, b.Users)
			}
		}
	})
	t.Run("cross-workspace rows never match", func(t *testing.T) {
		b := get(t, "ada")
		u, g := ids(b.Users), ids(b.Groups)
		if u[foreign] || g[foreignGroup] || !u[ada] || !g[adaGroup] {
			t.Fatalf("got %+v", b)
		}
		if b := get(t, "foreign"); len(b.Users) != 0 || len(b.Groups) != 0 {
			t.Fatalf("foreign matched %+v", b)
		}
	})
	t.Run("empty q is no filter and order is stable", func(t *testing.T) {
		rec := env.do("role=approver")
		var all candidateQBody
		_ = json.Unmarshal(rec.Body.Bytes(), &all)
		for _, q := range []string{"", "   "} {
			b := get(t, q)
			if fmt.Sprint(b) != fmt.Sprint(all) {
				t.Fatalf("q=%q = %+v, unfiltered = %+v", q, b, all)
			}
		}
		twins := get(t, "twin").Users
		lo, hi := dup1, dup2
		if hi < lo {
			lo, hi = hi, lo
		}
		if len(twins) != 2 || twins[0].ID != lo || twins[1].ID != hi {
			t.Fatalf("twins = %+v", twins)
		}
	})
	t.Run("over 100 characters is 400 invalid-query", func(t *testing.T) {
		if rec := env.do("role=approver&q=" + strings.Repeat("é", 100)); rec.Code != http.StatusOK {
			t.Fatalf("100 runes: %d %s", rec.Code, rec.Body.String())
		}
		if rec := env.do("role=approver&q=" + url.QueryEscape("  "+strings.Repeat("a", 100)+"  ")); rec.Code != http.StatusOK {
			t.Fatalf("100 after trim: %d %s", rec.Code, rec.Body.String())
		}
		p := assertProblem(t, env.do("role=approver&q="+strings.Repeat("a", 101)), http.StatusBadRequest, CodeInvalidRequest, "")
		if len(p.Errors) != 1 || p.Errors[0].Path != "q" || p.Errors[0].Code != "invalid-query" {
			t.Fatalf("errors = %+v", p.Errors)
		}
	})
}

func TestMemoryApproverCandidatesQuery(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	other := createSecondWorkspace(t, h, admin, tenant)
	pick := func(o bool) identity.Workspace {
		if o {
			return other
		}
		return ws
	}
	runCandidateQChecks(t, candidateQEnv{
		do: func(rawQuery string) *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/approvals/approver-candidates?"+rawQuery, nil, admin, tenant, ws))
			return rec
		},
		member: func(o bool, subject, name string) string {
			return putMember(t, h, admin, tenant, pick(o), fmt.Sprintf(`{"issuer":"https://idp.example","external_subject":%q,"display_name":%q,"role_keys":["approver"]}`, subject, name)).User.ID
		},
		group: func(o bool, name string) string {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workspace/groups", []byte(fmt.Sprintf(`{"displayName":%q}`, name)), admin, tenant, pick(o)))
			if rec.Code != http.StatusCreated {
				t.Fatalf("group: %d %s", rec.Code, rec.Body.String())
			}
			var g identity.Group
			_ = json.Unmarshal(rec.Body.Bytes(), &g)
			return g.ID
		},
	})
}

func TestApproverCandidatesQueryAgainstPostgres(t *testing.T) {
	th := newTargetsHarness(t)
	oTenant, oWS, _ := th.newWorkspace(fmt.Sprintf("q6x%d", th.n%1_000_000_000_000), "q6xwb")
	pick := func(o bool) (identity.Tenant, identity.Workspace) {
		if o {
			return oTenant, oWS
		}
		return th.tenant, th.ws
	}
	runCandidateQChecks(t, candidateQEnv{
		do: func(rawQuery string) *httptest.ResponseRecorder {
			return th.do(th.owner, http.MethodGet, "/api/v1/approvals/approver-candidates?"+rawQuery, "")
		},
		member: func(o bool, subject, name string) string {
			tn, w := pick(o)
			return putMember(t, th.h, th.owner, tn, w, fmt.Sprintf(`{"issuer":"https://idp.example","external_subject":"%s-%d","display_name":%q,"role_keys":["approver"]}`, subject, th.n, name)).User.ID
		},
		group: func(o bool, name string) string {
			tn, w := pick(o)
			return th.groupIn(tn, w, name)
		},
	})
}
