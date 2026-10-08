package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

// groupFixture is one tenant + workspace with an admin, plus an owner
// pool (no SET ROLE) for inspecting rows under FORCE RLS.
type groupFixture struct {
	ctx   context.Context
	pool  *pgxpool.Pool
	admin *pgxpool.Pool
	store *Postgres
	ws    Workspace
	owner User
}

func newGroupFixture(t *testing.T) *groupFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	dsn := testDatabaseURL(t)
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	f := &groupFixture{ctx: ctx, pool: pool, admin: admin, store: NewPostgres(pool)}
	f.ws, f.owner = f.newWorkspace(t)
	return f
}

func (f *groupFixture) newWorkspace(t *testing.T) (Workspace, User) {
	t.Helper()
	suffix := newID()[:8]
	tenant, err := f.store.CreateTenant(f.ctx, "g-"+suffix, "Groups "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := f.store.UpsertUser(f.ctx, "https://idp.example", "owner-"+suffix, "Owner "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := f.store.CreateWorkspace(f.ctx, tenant.ID, "bench-"+suffix, "Groups "+suffix, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	return ws, owner
}

// member creates a user bound in ws with roles.
func (f *groupFixture) member(t *testing.T, ws Workspace, name string, roles ...string) User {
	t.Helper()
	u, err := f.store.UpsertUser(f.ctx, "https://idp.example", name+"-"+newID()[:8], name)
	if err != nil {
		t.Fatal(err)
	}
	if len(roles) > 0 {
		if err := f.store.SetMemberRoles(f.ctx, ws.ID, u.ID, roles, MemberActor{Via: MemberViaSystem}); err != nil {
			t.Fatal(err)
		}
	}
	return u
}

func (f *groupFixture) actor() GroupActor {
	return GroupActor{UserID: f.owner.ID, RequestID: "req-" + newID()}
}

func (f *groupFixture) group(t *testing.T, name string) Group {
	t.Helper()
	g, err := f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), name)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func (f *groupFixture) add(t *testing.T, groupID, userID string) {
	t.Helper()
	if err := f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), groupID, userID); err != nil {
		t.Fatal(err)
	}
}

// memberRows counts membership rows as the owner role (RLS bypassed).
func (f *groupFixture) memberRows(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	if err := f.admin.QueryRow(f.ctx, `SELECT count(*) FROM workspace_group_members WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// helpers runs both #558 helpers in a fresh workspace-scoped tx.
func (f *groupFixture) helpers(t *testing.T, userID string, groupIDs, direct []string) (bool, []string) {
	t.Helper()
	tx, err := postgres.BeginScoped(f.ctx, f.pool, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	in, err := InTargetGroups(f.ctx, tx, f.ws.ID, userID, groupIDs)
	if err != nil {
		t.Fatal(err)
	}
	users, err := ResolveTargetUsers(f.ctx, tx, f.ws.ID, groupIDs, direct)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	return in, users
}

func findMember(d GroupDetail, userID string) (GroupMember, bool) {
	for _, m := range d.Members {
		if m.UserID == userID {
			return m, true
		}
	}
	return GroupMember{}, false
}

func TestPostgresGroupCRUDCascadeAndAudit(t *testing.T) {
	f := newGroupFixture(t)
	approver := f.member(t, f.ws, "Approver", authz.RoleApprover)
	viewer := f.member(t, f.ws, "viewer", authz.RoleViewer)

	g, err := f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), "  Change Board  ")
	if err != nil {
		t.Fatal(err)
	}
	if g.DisplayName != "Change Board" || g.MemberCount != 0 {
		t.Fatalf("created %+v", g)
	}
	f.add(t, g.ID, approver.ID)
	f.add(t, g.ID, approver.ID) // idempotent, no second audit row
	f.add(t, g.ID, viewer.ID)

	d, err := f.store.GetGroup(f.ctx, f.ws.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.MemberCount != 2 || len(d.Members) != 2 {
		t.Fatalf("detail %+v", d)
	}
	if d.Members[0].UserID != approver.ID || !d.Members[0].CanApprove {
		t.Fatalf("approver member %+v", d.Members[0])
	}
	if d.Members[1].UserID != viewer.ID || d.Members[1].CanApprove {
		t.Fatalf("viewer member %+v", d.Members[1])
	}

	items, next, err := f.store.ListGroupsPage(f.ctx, f.ws.ID, page.Query{Bound: true, Limit: 10})
	if err != nil || next != "" || len(items) != 1 || items[0].MemberCount != 2 {
		t.Fatalf("list = %+v next=%q err=%v", items, next, err)
	}

	renamed, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), g.ID, "CHANGE board")
	if err != nil {
		t.Fatalf("rename to own name in another case: %v", err)
	}
	if renamed.DisplayName != "CHANGE board" || renamed.MemberCount != 2 {
		t.Fatalf("renamed %+v", renamed)
	}

	if err := f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, viewer.ID); err != nil {
		t.Fatalf("idempotent remove: %v", err)
	}

	if err := f.store.DeleteGroup(f.ctx, f.ws.ID, f.actor(), g.ID); err != nil {
		t.Fatal(err)
	}
	if n := f.memberRows(t, "workspace_id = $1 AND group_id = $2", f.ws.ID, g.ID); n != 0 {
		t.Fatalf("cascade left %d member rows", n)
	}
	if _, err := f.store.GetGroup(f.ctx, f.ws.ID, g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get deleted = %v", err)
	}
	if err := f.store.DeleteGroup(f.ctx, f.ws.ID, f.actor(), g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}

	rows, err := f.admin.Query(f.ctx, `
		SELECT action, resource_type, actor_id::text, outcome, details_redacted
		FROM audit_events WHERE workspace_id = $1 AND resource_id = $2
		ORDER BY occurred_at, action`, f.ws.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var actions []string
	for rows.Next() {
		var action, rtype, actor, outcome string
		var raw []byte
		if err := rows.Scan(&action, &rtype, &actor, &outcome, &raw); err != nil {
			t.Fatal(err)
		}
		if rtype != AuditGroupResource || actor != f.owner.ID || outcome == "" {
			t.Fatalf("audit row %s %s %s %s", action, rtype, actor, outcome)
		}
		var details map[string]any
		if err := json.Unmarshal(raw, &details); err != nil {
			t.Fatal(err)
		}
		for k := range details {
			if k != "groupId" && k != "userId" {
				t.Fatalf("audit %s carries non-id detail %q", action, k)
			}
		}
		actions = append(actions, action)
	}
	want := map[string]int{
		AuditGroupCreate: 1, AuditGroupMemberAdd: 2, AuditGroupRename: 1,
		AuditGroupMemberRemove: 1, AuditGroupDelete: 1,
	}
	got := map[string]int{}
	for _, a := range actions {
		got[a]++
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("audit actions = %v, want %v", got, want)
	}
}

func TestPostgresGroupNameClashIsCaseInsensitive(t *testing.T) {
	f := newGroupFixture(t)
	f.group(t, "Ops Leads")
	other := f.group(t, "Security")
	if _, err := f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), "ops leads"); !errors.Is(err, ErrGroupNameTaken) {
		t.Fatalf("create clash = %v", err)
	}
	if _, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), other.ID, "OPS LEADS"); !errors.Is(err, ErrGroupNameTaken) {
		t.Fatalf("rename clash = %v", err)
	}
	for _, bad := range []string{"", "   ", string(make([]rune, 129)), "a\nb"} {
		if _, err := f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), bad); !errors.Is(err, ErrGroupNameInvalid) {
			t.Fatalf("create %q = %v", bad, err)
		}
	}
	// Another workspace may reuse the name.
	ws2, owner2 := f.newWorkspace(t)
	if _, err := f.store.CreateGroup(f.ctx, ws2.ID, GroupActor{UserID: owner2.ID}, "OPS LEADS"); err != nil {
		t.Fatalf("other workspace same name: %v", err)
	}
}

func TestPostgresGroupConcurrentCreateRaceMapsToNameTaken(t *testing.T) {
	f := newGroupFixture(t)
	const n = 12
	var wg sync.WaitGroup
	errs := make([]error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			name := "Release Approvers"
			if i%2 == 1 {
				name = "release APPROVERS"
			}
			_, errs[i] = f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), name)
		}(i)
	}
	close(start)
	wg.Wait()
	ok := 0
	for i, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrGroupNameTaken):
		default:
			t.Fatalf("racer %d: %v", i, err)
		}
	}
	if ok != 1 {
		t.Fatalf("%d creates won, want exactly 1", ok)
	}
}

func TestPostgresGroupRLSSecondTenant(t *testing.T) {
	f := newGroupFixture(t)
	approver := f.member(t, f.ws, "Approver", authz.RoleApprover)
	g := f.group(t, "Tenant A Group")
	f.add(t, g.ID, approver.ID)

	wsB, ownerB := f.newWorkspace(t)
	actorB := GroupActor{UserID: ownerB.ID}
	if _, err := f.store.GetGroup(f.ctx, wsB.ID, g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get from B = %v", err)
	}
	if _, err := f.store.RenameGroup(f.ctx, wsB.ID, actorB, g.ID, "Stolen"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rename from B = %v", err)
	}
	if err := f.store.AddGroupMember(f.ctx, wsB.ID, actorB, g.ID, ownerB.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("add from B = %v", err)
	}
	if err := f.store.RemoveGroupMember(f.ctx, wsB.ID, actorB, g.ID, approver.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("remove from B = %v", err)
	}
	if err := f.store.DeleteGroup(f.ctx, wsB.ID, actorB, g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete from B = %v", err)
	}
	items, _, err := f.store.ListGroupsPage(f.ctx, wsB.ID, page.Query{Bound: true, Limit: 50})
	if err != nil || len(items) != 0 {
		t.Fatalf("list B = %+v %v", items, err)
	}

	// Raw reads under B's scope see none of A's rows, even naming A's
	// workspace id explicitly. Helpers called with A's ids under B's
	// scope match nobody.
	tx, err := postgres.BeginScoped(f.ctx, f.pool, wsB.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	var groups, members int
	if err := tx.QueryRow(f.ctx, `SELECT count(*) FROM workspace_groups WHERE workspace_id = $1`, f.ws.ID).Scan(&groups); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(f.ctx, `SELECT count(*) FROM workspace_group_members WHERE workspace_id = $1`, f.ws.ID).Scan(&members); err != nil {
		t.Fatal(err)
	}
	if groups != 0 || members != 0 {
		t.Fatalf("B scope sees %d groups, %d members of A", groups, members)
	}
	in, err := InTargetGroups(f.ctx, tx, f.ws.ID, approver.ID, []string{g.ID})
	if err != nil || in {
		t.Fatalf("InTargetGroups across scope = %v %v", in, err)
	}
	users, err := ResolveTargetUsers(f.ctx, tx, f.ws.ID, []string{g.ID}, nil)
	if err != nil || len(users) != 0 {
		t.Fatalf("ResolveTargetUsers across scope = %v %v", users, err)
	}
	// Writes under B's scope cannot plant rows in A.
	if _, err := tx.Exec(f.ctx, `INSERT INTO workspace_groups (workspace_id, display_name) VALUES ($1, 'x')`, f.ws.ID); err == nil {
		t.Fatal("insert into A under B scope succeeded")
	}
}

func TestPostgresGroupAddRejectsNonMembers(t *testing.T) {
	f := newGroupFixture(t)
	g := f.group(t, "Approvers")
	unbound := f.member(t, f.ws, "Unbound")
	disabled := f.member(t, f.ws, "Disabled", authz.RoleApprover)
	if err := f.store.SetUserStatus(f.ctx, disabled.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	wsB, _ := f.newWorkspace(t)
	foreign := f.member(t, wsB, "Foreign", authz.RoleApprover)
	for name, id := range map[string]string{
		"unbound": unbound.ID, "disabled": disabled.ID, "other-workspace": foreign.ID,
		"unknown": newID(), "malformed": "not-a-uuid",
	} {
		if err := f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, id); !errors.Is(err, ErrGroupMemberNotInWorkspace) {
			t.Fatalf("%s add = %v", name, err)
		}
	}
	if n := f.memberRows(t, "group_id = $1", g.ID); n != 0 {
		t.Fatalf("rejected adds left %d rows", n)
	}
	if err := f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), newID(), f.owner.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("add to missing group = %v", err)
	}
	// A missing group stays 404 ahead of the member check, even though
	// the binding read now runs first.
	if err := f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), newID(), unbound.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("add unbound user to missing group = %v", err)
	}
}

// A groupId that is not a UUID is not-found on every group store call,
// like the other resource stores. A userId that is not a UUID on removal
// is invalid, like RemoveMember.
func TestPostgresGroupNonUUIDPathIDs(t *testing.T) {
	f := newGroupFixture(t)
	g := f.group(t, "Path ids")
	u := f.member(t, f.ws, "Pathy", authz.RoleApprover)
	f.add(t, g.ID, u.ID)
	checks := map[string]error{
		"get":              func() error { _, err := f.store.GetGroup(f.ctx, f.ws.ID, "not-a-uuid"); return err }(),
		"rename":           func() error { _, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), "not-a-uuid", "X"); return err }(),
		"delete":           f.store.DeleteGroup(f.ctx, f.ws.ID, f.actor(), "not-a-uuid"),
		"add bad group":    f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), "not-a-uuid", u.ID),
		"remove bad group": f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), "not-a-uuid", u.ID),
	}
	for name, err := range checks {
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s = %v, want ErrNotFound", name, err)
		}
	}
	if err := f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, "not-a-uuid"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("remove bad user = %v, want ErrInvalid", err)
	}
	// A valid id that is not a member stays an idempotent no-op.
	if err := f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, newID()); err != nil {
		t.Fatalf("remove non-member = %v", err)
	}
	if n := f.memberRows(t, "group_id = $1", g.ID); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
}

// Lock order: AddGroupMember and RemoveMember both take the binding rows
// first and group rows second. Here RemoveMember holds the binding
// delete while it waits on a member-row FOR SHARE held elsewhere; an add
// to a second group queues on the bindings (not on a group row), and once
// RemoveMember commits the add is refused. No deadlock, no orphan row.
func TestAddGroupMemberLosesToRemoveMemberWithoutDeadlock(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Leaver", authz.RoleApprover)
	g1 := f.group(t, "Held")
	g2 := f.group(t, "Target")
	f.add(t, g1.ID, u.ID)

	holder, err := postgres.BeginScoped(f.ctx, f.pool, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(f.ctx)
	if in, err := InTargetGroups(f.ctx, holder, f.ws.ID, u.ID, []string{g1.ID}); err != nil || !in {
		t.Fatalf("holder check = %v %v", in, err)
	}

	removed := make(chan error, 1)
	go func() { removed <- f.store.RemoveMember(f.ctx, f.ws.ID, u.ID, MemberActor{Via: MemberViaSystem}) }()
	// Let RemoveMember delete the bindings and block on g1's member row.
	time.Sleep(300 * time.Millisecond)
	added := make(chan error, 1)
	go func() { added <- f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), g2.ID, u.ID) }()
	select {
	case err := <-removed:
		t.Fatalf("RemoveMember finished while the member row was held: %v", err)
	case err := <-added:
		t.Fatalf("add finished while RemoveMember held the bindings: %v", err)
	case <-time.After(400 * time.Millisecond):
	}
	if err := holder.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	for name, ch := range map[string]chan error{"RemoveMember": removed, "AddGroupMember": added} {
		select {
		case err := <-ch:
			if name == "RemoveMember" && err != nil {
				t.Fatalf("RemoveMember = %v", err)
			}
			if name == "AddGroupMember" && !errors.Is(err, ErrGroupMemberNotInWorkspace) {
				t.Fatalf("add after RemoveMember won = %v, want ErrGroupMemberNotInWorkspace", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not finish (deadlock?)", name)
		}
	}
	if n := f.memberRows(t, "user_id = $1", u.ID); n != 0 {
		t.Fatalf("removed user still has %d group rows", n)
	}
}

// Racing AddGroupMember against RemoveMember many times never deadlocks
// (no 40P01) and never leaves a group row for a removed user. The add
// either lands first (and RemoveMember deletes it) or is refused.
func TestAddGroupMemberVsRemoveMemberNeverDeadlocks(t *testing.T) {
	f := newGroupFixture(t)
	g1 := f.group(t, "Race one")
	g2 := f.group(t, "Race two")
	for i := range 20 {
		u := f.member(t, f.ws, fmt.Sprintf("Racer%d", i), authz.RoleApprover)
		f.add(t, g1.ID, u.ID)
		var wg sync.WaitGroup
		var addErr, removeErr error
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			addErr = f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), g2.ID, u.ID)
		}()
		go func() {
			defer wg.Done()
			<-start
			removeErr = f.store.RemoveMember(f.ctx, f.ws.ID, u.ID, MemberActor{Via: MemberViaSystem})
		}()
		close(start)
		wg.Wait()
		if removeErr != nil {
			t.Fatalf("iteration %d: RemoveMember = %v", i, removeErr)
		}
		if addErr != nil && !errors.Is(addErr, ErrGroupMemberNotInWorkspace) {
			t.Fatalf("iteration %d: add = %v", i, addErr)
		}
		if n := f.memberRows(t, "user_id = $1", u.ID); n != 0 {
			t.Fatalf("iteration %d: removed user has %d group rows", i, n)
		}
	}
}

// QA (a): a SCIM-disabled user (users.status != 'active') drops out of
// both helpers but stays listed in group detail with canApprove false.
func TestGroupHelpersDisabledUserDropsOut(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Disabled Later", authz.RoleApprover)
	g := f.group(t, "Disable Target")
	f.add(t, g.ID, u.ID)

	in, users := f.helpers(t, u.ID, []string{g.ID}, nil)
	if !in || !slices.Equal(users, []string{u.ID}) {
		t.Fatalf("before disable: in=%v users=%v", in, users)
	}
	if err := f.store.SetUserStatus(f.ctx, u.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	in, users = f.helpers(t, u.ID, []string{g.ID}, []string{u.ID})
	if in || len(users) != 0 {
		t.Fatalf("after disable: in=%v users=%v", in, users)
	}
	d, err := f.store.GetGroup(f.ctx, f.ws.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	m, ok := findMember(d, u.ID)
	if !ok || m.CanApprove {
		t.Fatalf("disabled member listed=%v canApprove=%v", ok, m.CanApprove)
	}
}

// QA (b): a user removed from the workspace (RemoveMember) drops out of
// both helpers, and their group rows are deleted in the same transaction.
func TestGroupHelpersRemoveMemberDropsOutAndDeletesRows(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Removed", authz.RoleApprover)
	keep := f.member(t, f.ws, "Kept", authz.RoleApprover)
	g1 := f.group(t, "Remove One")
	g2 := f.group(t, "Remove Two")
	f.add(t, g1.ID, u.ID)
	f.add(t, g2.ID, u.ID)
	f.add(t, g1.ID, keep.ID)

	if err := f.store.RemoveMember(f.ctx, f.ws.ID, u.ID, MemberActor{Via: MemberViaSystem}); err != nil {
		t.Fatal(err)
	}
	if n := f.memberRows(t, "workspace_id = $1 AND user_id = $2", f.ws.ID, u.ID); n != 0 {
		t.Fatalf("RemoveMember left %d group rows", n)
	}
	if n := f.memberRows(t, "workspace_id = $1 AND user_id = $2", f.ws.ID, keep.ID); n != 1 {
		t.Fatalf("other member rows = %d", n)
	}
	in, users := f.helpers(t, u.ID, []string{g1.ID, g2.ID}, []string{u.ID})
	if in || !slices.Equal(users, []string{keep.ID}) {
		t.Fatalf("after remove: in=%v users=%v", in, users)
	}
	d, err := f.store.GetGroup(f.ctx, f.ws.ID, g1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := findMember(d, u.ID); ok {
		t.Fatal("removed user still listed in group detail")
	}
	if err := f.store.RemoveMember(f.ctx, f.ws.ID, u.ID, MemberActor{Via: MemberViaSystem}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second RemoveMember = %v", err)
	}
}

// RemoveMember keeps ErrLastAdmin and then deletes nothing.
func TestPostgresRemoveMemberLastAdminKeepsGroupRows(t *testing.T) {
	f := newGroupFixture(t)
	g := f.group(t, "Admins")
	f.add(t, g.ID, f.owner.ID)
	if err := f.store.RemoveMember(f.ctx, f.ws.ID, f.owner.ID, MemberActor{Via: MemberViaSystem}); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("remove last admin = %v", err)
	}
	if n := f.memberRows(t, "group_id = $1 AND user_id = $2", g.ID, f.owner.ID); n != 1 {
		t.Fatalf("last-admin rollback left %d rows", n)
	}
}

// QA (c): FOR SHARE on the matched membership row makes a concurrent
// removal wait for the transaction holding InTargetGroups. Readers see
// the state cleanly before or after the removal, never in between.
func TestInTargetGroupsForShareBlocksConcurrentRemoval(t *testing.T) {
	removals := map[string]func(f *groupFixture, groupID, userID string) error{
		"group_member_remove": func(f *groupFixture, groupID, userID string) error {
			return f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), groupID, userID)
		},
		"workspace_remove_member": func(f *groupFixture, _ string, userID string) error {
			return f.store.RemoveMember(f.ctx, f.ws.ID, userID, MemberActor{Via: MemberViaSystem})
		},
	}
	for name, remove := range removals {
		t.Run(name, func(t *testing.T) {
			f := newGroupFixture(t)
			u := f.member(t, f.ws, "Racer", authz.RoleApprover)
			g := f.group(t, "Race "+name)
			f.add(t, g.ID, u.ID)

			tx, err := postgres.BeginScoped(f.ctx, f.pool, f.ws.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(f.ctx)
			in, err := InTargetGroups(f.ctx, tx, f.ws.ID, u.ID, []string{g.ID})
			if err != nil || !in {
				t.Fatalf("first check = %v %v", in, err)
			}

			done := make(chan error, 1)
			go func() { done <- remove(f, g.ID, u.ID) }()
			select {
			case err := <-done:
				t.Fatalf("removal finished while FOR SHARE was held: %v", err)
			case <-time.After(400 * time.Millisecond):
			}
			// The holder still sees the before state.
			in, err = InTargetGroups(f.ctx, tx, f.ws.ID, u.ID, []string{g.ID})
			if err != nil || !in {
				t.Fatalf("recheck under lock = %v %v", in, err)
			}
			if err := tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("removal after commit: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("removal did not finish after the holder committed")
			}
			in, users := f.helpers(t, u.ID, []string{g.ID}, nil)
			if in || len(users) != 0 {
				t.Fatalf("after removal: in=%v users=%v", in, users)
			}
		})
	}
}

// The reverse order: a removal that already holds the row makes
// InTargetGroups wait, and then it sees the after state (no match).
func TestInTargetGroupsWaitsForInFlightRemoval(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Racer", authz.RoleApprover)
	g := f.group(t, "Race Reverse")
	f.add(t, g.ID, u.ID)

	rm, err := postgres.BeginScoped(f.ctx, f.pool, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rm.Rollback(f.ctx)
	if _, err := rm.Exec(f.ctx, `DELETE FROM workspace_group_members WHERE workspace_id = $1 AND group_id = $2 AND user_id = $3`, f.ws.ID, g.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	type result struct {
		in  bool
		err error
	}
	done := make(chan result, 1)
	go func() {
		tx, err := postgres.BeginScoped(f.ctx, f.pool, f.ws.ID)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer tx.Rollback(f.ctx)
		in, err := InTargetGroups(f.ctx, tx, f.ws.ID, u.ID, []string{g.ID})
		done <- result{in: in, err: err}
	}()
	select {
	case <-done:
		t.Fatal("InTargetGroups did not wait for the in-flight removal")
	case <-time.After(400 * time.Millisecond):
	}
	if err := rm.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatal(r.err)
		}
		if r.in {
			t.Fatal("InTargetGroups matched a row deleted by a committed removal")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("InTargetGroups did not finish")
	}
}

// QA (d): a deleted group resolves to nobody. Direct users still resolve.
func TestGroupHelpersDeletedGroupResolvesToNobody(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Orphan", authz.RoleApprover)
	direct := f.member(t, f.ws, "Direct", authz.RoleApprover)
	g := f.group(t, "Deleted Group")
	f.add(t, g.ID, u.ID)
	if err := f.store.DeleteGroup(f.ctx, f.ws.ID, f.actor(), g.ID); err != nil {
		t.Fatal(err)
	}
	in, users := f.helpers(t, u.ID, []string{g.ID}, nil)
	if in || len(users) != 0 {
		t.Fatalf("deleted group: in=%v users=%v", in, users)
	}
	_, users = f.helpers(t, u.ID, []string{g.ID}, []string{direct.ID})
	if !slices.Equal(users, []string{direct.ID}) {
		t.Fatalf("deleted group plus direct user = %v", users)
	}
	// Malformed and empty inputs also resolve to nobody.
	in, users = f.helpers(t, u.ID, []string{"not-a-uuid", ""}, []string{"nope"})
	if in || len(users) != 0 {
		t.Fatalf("malformed ids: in=%v users=%v", in, users)
	}
}

// Helpers require a live binding: an active user with no binding never
// matches, even with a membership row planted by the owner role, and
// group detail reports canApprove false for that row.
func TestGroupHelpersRequireLiveBinding(t *testing.T) {
	f := newGroupFixture(t)
	g := f.group(t, "Binding Check")
	unbound := f.member(t, f.ws, "Unbound")
	if _, err := f.admin.Exec(f.ctx, `INSERT INTO workspace_group_members (workspace_id, group_id, user_id) VALUES ($1, $2, $3)`, f.ws.ID, g.ID, unbound.ID); err != nil {
		t.Fatal(err)
	}
	in, users := f.helpers(t, unbound.ID, []string{g.ID}, []string{unbound.ID})
	if in || len(users) != 0 {
		t.Fatalf("unbound user: in=%v users=%v", in, users)
	}
	d, err := f.store.GetGroup(f.ctx, f.ws.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if m, ok := findMember(d, unbound.ID); !ok || m.CanApprove {
		t.Fatalf("unbound member listed=%v canApprove=%v", ok, m.CanApprove)
	}
}

func TestPostgresGroupListPagesBySortedName(t *testing.T) {
	f := newGroupFixture(t)
	for _, name := range []string{"delta", "Alpha", "charlie", "Bravo", "echo"} {
		f.group(t, name)
	}
	var seen []string
	cursor := ""
	for i := 0; i < 5; i++ {
		items, next, err := f.store.ListGroupsPage(f.ctx, f.ws.ID, page.Query{Bound: true, Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range items {
			seen = append(seen, g.DisplayName)
		}
		if next == "" {
			break
		}
		cursor = next
	}
	want := []string{"Alpha", "Bravo", "charlie", "delta", "echo"}
	if !slices.Equal(seen, want) {
		t.Fatalf("paged = %v, want %v", seen, want)
	}
	items, _, err := f.store.ListGroupsPage(f.ctx, f.ws.ID, page.Query{Bound: true, Limit: 50, Q: "AR"})
	if err != nil || len(items) != 1 || items[0].DisplayName != "charlie" {
		t.Fatalf("search = %+v %v", items, err)
	}
}

// SetMemberRoles replaces roles by deleting and reinserting the binding
// rows. An add that waits on the deleted rows must not refuse a member
// who is still bound once that commits: AddGroupMember retries once in
// a fresh transaction. Here the role change is held open by hand with
// the same delete-and-reinsert statements.
func TestAddGroupMemberSurvivesConcurrentSetMemberRoles(t *testing.T) {
	f := newGroupFixture(t)
	u := f.member(t, f.ws, "Rerole", authz.RoleViewer)
	g := f.group(t, "Rerole target")

	tx, err := f.admin.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, `DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, f.ws.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.ctx, `
		INSERT INTO workspace_role_bindings (workspace_id, user_id, role_id)
		SELECT $1::uuid, $2::uuid, r.id FROM roles r WHERE r.key = $3`, f.ws.ID, u.ID, authz.RoleApprover); err != nil {
		t.Fatal(err)
	}

	added := make(chan error, 1)
	go func() { added <- f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), g.ID, u.ID) }()
	select {
	case err := <-added:
		t.Fatalf("add finished while the role change held the bindings: %v", err)
	case <-time.After(400 * time.Millisecond):
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-added:
		if err != nil {
			t.Fatalf("add after a concurrent role change = %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("add did not finish after the role change committed")
	}
	if n := f.memberRows(t, "group_id = $1 AND user_id = $2", g.ID, u.ID); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
	// The real store call, racing, never refuses a still-bound member.
	g2 := f.group(t, "Rerole race")
	for i := range 10 {
		roles := []string{authz.RoleApprover}
		if i%2 == 1 {
			roles = []string{authz.RoleViewer}
		}
		var wg sync.WaitGroup
		var addErr, setErr error
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			addErr = f.store.AddGroupMember(f.ctx, f.ws.ID, f.actor(), g2.ID, u.ID)
		}()
		go func() {
			defer wg.Done()
			<-start
			setErr = f.store.SetMemberRoles(f.ctx, f.ws.ID, u.ID, roles, MemberActor{Via: MemberViaSystem})
		}()
		close(start)
		wg.Wait()
		if addErr != nil || setErr != nil {
			t.Fatalf("iteration %d: add = %v, set roles = %v", i, addErr, setErr)
		}
		if err := f.store.RemoveGroupMember(f.ctx, f.ws.ID, f.actor(), g2.ID, u.ID); err != nil {
			t.Fatal(err)
		}
	}
}

// Renames race on the unique name index the same way creates do: two
// renames to one name, or a rename against a create, give exactly one
// winner and one ErrGroupNameTaken (409 group_name_taken), never another
// error (which the handler would turn into a 500).
func TestPostgresGroupConcurrentRenameRaceMapsToNameTaken(t *testing.T) {
	f := newGroupFixture(t)
	for i := range 10 {
		a := f.group(t, fmt.Sprintf("Rename A %d", i))
		b := f.group(t, fmt.Sprintf("Rename B %d", i))
		target := fmt.Sprintf("Clash %d", i)
		var wg sync.WaitGroup
		errs := make([]error, 3)
		start := make(chan struct{})
		run := func(slot int, fn func() error) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				errs[slot] = fn()
			}()
		}
		run(0, func() error { _, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), a.ID, target); return err })
		run(1, func() error {
			_, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), b.ID, strings.ToUpper(target))
			return err
		})
		run(2, func() error {
			_, err := f.store.CreateGroup(f.ctx, f.ws.ID, f.actor(), strings.ToLower(target))
			return err
		})
		close(start)
		wg.Wait()
		won := 0
		for slot, err := range errs {
			switch {
			case err == nil:
				won++
			case errors.Is(err, ErrGroupNameTaken):
			default:
				t.Fatalf("iteration %d racer %d: %v", i, slot, err)
			}
		}
		if won != 1 {
			t.Fatalf("iteration %d: %d racers won, want exactly 1 (%v)", i, won, errs)
		}
	}
}

// A rename to the exact current name (after trimming) changes nothing:
// no audit row and no updatedAt bump. A case-only change is a rename and
// is audited.
func TestPostgresGroupRenameToSameNameWritesNoAudit(t *testing.T) {
	f := newGroupFixture(t)
	g := f.group(t, "Steady")
	renames := func() int {
		var n int
		if err := f.admin.QueryRow(f.ctx, `SELECT count(*) FROM audit_events WHERE workspace_id = $1 AND resource_id = $2 AND action = $3`,
			f.ws.ID, g.ID, AuditGroupRename).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	got, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), g.ID, "  Steady ")
	if err != nil || got.DisplayName != "Steady" || !got.UpdatedAt.Equal(g.UpdatedAt) {
		t.Fatalf("same-name rename = %+v %v (created %+v)", got, err, g)
	}
	if n := renames(); n != 0 {
		t.Fatalf("same-name rename wrote %d audit rows", n)
	}
	if got, err := f.store.RenameGroup(f.ctx, f.ws.ID, f.actor(), g.ID, "STEADY"); err != nil || got.DisplayName != "STEADY" {
		t.Fatalf("case rename = %+v %v", got, err)
	}
	if n := renames(); n != 1 {
		t.Fatalf("case rename wrote %d audit rows, want 1", n)
	}
}
