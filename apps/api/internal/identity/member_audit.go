package identity

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
)

// Workspace role changes and removals write one audit row each, in the
// same transaction as the change, so a refused or rolled-back change
// leaves no row and every committed change has exactly one.
const (
	// AuditMemberRolesChange: a member's role set changed (including a
	// first grant, rolesBefore empty).
	AuditMemberRolesChange = "workspace_member.roles_change"
	// AuditMemberRemove: every role binding of the member was removed.
	AuditMemberRemove = "workspace_member.remove"
	// AuditMemberResource is the resource_type; resource_id is the
	// member's user UUID.
	AuditMemberResource = "workspace_member"
)

// MemberActor values for Via. A session user is recorded by UserID; a
// workspace SCIM token by SCIMTokenID (via scim_token, the same
// convention as the SCIM group rows).
const (
	MemberViaSCIMToken         = "scim_token"
	MemberViaSCIMInstanceToken = "scim_instance_token"
	MemberViaSystem            = "system"
)

// MemberActor says who changed a member's roles. Exactly one of UserID
// (a session user), SCIMTokenID (a workspace SCIM token's row id, never
// the token) or Via (MemberViaSCIMInstanceToken for the instance SCIM
// bearer, MemberViaSystem for the local/dev seed) is set; anything else
// is ErrInvalid, so no role change can be written without an actor.
type MemberActor struct {
	UserID      string
	RequestID   string
	SCIMTokenID string
	Via         string
}

// Valid reports whether exactly one actor kind is set.
func (a MemberActor) Valid() bool {
	n := 0
	if strings.TrimSpace(a.UserID) != "" {
		if !authz.ValidUUID(strings.TrimSpace(a.UserID)) {
			return false
		}
		n++
	}
	if strings.TrimSpace(a.SCIMTokenID) != "" {
		if !authz.ValidUUID(strings.TrimSpace(a.SCIMTokenID)) {
			return false
		}
		n++
	}
	switch a.Via {
	case "":
	case MemberViaSCIMInstanceToken, MemberViaSystem:
		n++
	default:
		return false
	}
	return n == 1
}

// InsertMemberRolesAuditTx writes the audit row for userID's roles going
// from before to after in workspaceID, in the caller's transaction. Equal
// role sets write nothing; an empty after is AuditMemberRemove, anything
// else AuditMemberRolesChange. Details hold role keys only, the target's
// UUID and display name, and the actor: a session user's UUID (actor_id)
// and display name, or a token id with via scim_token, or via alone. A
// display name shaped like an email, URL or credential is left out; no
// email, token or secret is ever written.
func InsertMemberRolesAuditTx(ctx context.Context, tx pgx.Tx, workspaceID, userID string, before, after []string, actor MemberActor) error {
	if !actor.Valid() || !authz.ValidUUID(workspaceID) || !authz.ValidUUID(userID) {
		return ErrInvalid
	}
	before, after = uniqueSorted(before), uniqueSorted(after)
	if before == nil {
		before = []string{}
	}
	if after == nil {
		after = []string{}
	}
	if slices.Equal(before, after) {
		return nil
	}
	action, outcome := AuditMemberRolesChange, "updated"
	if len(after) == 0 {
		action, outcome = AuditMemberRemove, "deleted"
	}
	details := map[string]any{"userId": userID, "rolesBefore": before, "rolesAfter": after}
	if name, err := userDisplayNameTx(ctx, tx, userID); err != nil {
		return err
	} else if name != "" {
		details["displayName"] = name
	}
	actorID, err := addActorDetailsTx(ctx, tx, actor, details)
	if err != nil {
		return err
	}
	detailsRaw, err := json.Marshal(details)
	if err != nil {
		return ErrInvalid
	}
	hostRaw, rid, err := actorHostContext(actor)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (
			workspace_id, actor_id, host_context_redacted, action, resource_type,
			resource_id, outcome, correlation_id, details_redacted
		) VALUES (
			$1::uuid, $2::uuid, $3::jsonb, $4, $5,
			$6::uuid, $7, NULLIF($8, ''), $9::jsonb
		)
	`, workspaceID, actorID, hostRaw, action, AuditMemberResource, userID, outcome, rid, detailsRaw)
	return mapDBErr(err)
}

// addActorDetailsTx records actor the same way on every identity audit
// row: a session user is actor_id (returned) plus actorDisplayName; a
// workspace SCIM token is tokenId plus via scim_token; anything else is a
// fixed via constant (MemberActor.Valid allows no free text). The
// returned actor_id is nil when the actor is not a user.
func addActorDetailsTx(ctx context.Context, tx pgx.Tx, actor MemberActor, details map[string]any) (any, error) {
	switch {
	case strings.TrimSpace(actor.UserID) != "":
		id := strings.ToLower(strings.TrimSpace(actor.UserID))
		name, err := userDisplayNameTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if name != "" {
			details["actorDisplayName"] = name
		}
		return id, nil
	case strings.TrimSpace(actor.SCIMTokenID) != "":
		details["tokenId"] = strings.ToLower(strings.TrimSpace(actor.SCIMTokenID))
		details["via"] = MemberViaSCIMToken
	default:
		details["via"] = actor.Via
	}
	return nil, nil
}

// actorHostContext returns the host context JSON (request id only) and the
// correlation id for actor's request.
func actorHostContext(actor MemberActor) ([]byte, string, error) {
	host := map[string]string{}
	rid := auditCorrelation(actor.RequestID)
	if rid != "" {
		host["requestId"] = rid
	}
	raw, err := json.Marshal(host)
	if err != nil {
		return nil, "", ErrInvalid
	}
	return raw, rid, nil
}

// userDisplayNameTx returns the user's display name for an audit row, or
// "" when it is missing or shaped like an email, URL or credential.
func userDisplayNameTx(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var name string
	err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1::uuid`, userID).Scan(&name)
	if err != nil {
		if mapped := mapDBErr(err); mapped == ErrNotFound {
			return "", nil
		}
		return "", mapDBErr(err)
	}
	return auditDisplayName(name), nil
}

// MemberAuditRecord is the in-memory twin of one workspace_member audit
// row (tests only). The memory store records it for workspace creation,
// the one member-role write whose audit row is mirrored here.
type MemberAuditRecord struct {
	WorkspaceID  string
	Action       string
	UserID       string
	ActorUserID  string
	RolesBefore  []string
	RolesAfter   []string
	DisplayName  string
	ActorDisplay string
}

// MemberAudit returns the recorded member audit rows (tests only).
func (m *Memory) MemberAudit() []MemberAuditRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]MemberAuditRecord(nil), m.memberAudit...)
}
