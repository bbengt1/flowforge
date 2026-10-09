package approval

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/jackc/pgx/v5"
)

// loadTargetsTx fills the approver snapshot for targeted rows and the
// close cause for rows canceled as requirement_unresolvable. Plain reads.
func loadTargetsTx(ctx context.Context, tx pgx.Tx, recs []Record) error {
	var targeted, canceled []string
	for _, rec := range recs {
		if rec.Targeted() {
			targeted = append(targeted, rec.ID)
		}
		if rec.CloseReason == ReasonRequirementUnresolvable {
			canceled = append(canceled, rec.ID)
		}
	}
	users := map[string][]string{}
	groups := map[string][]string{}
	if len(targeted) > 0 {
		if err := collectPairs(ctx, tx, `
			SELECT approval_id::text, user_id::text FROM approval_approver_users
			 WHERE approval_id = ANY($1::uuid[]) ORDER BY approval_id, user_id`, targeted, users); err != nil {
			return err
		}
		if err := collectPairs(ctx, tx, `
			SELECT approval_id::text, group_id::text FROM approval_approver_groups
			 WHERE approval_id = ANY($1::uuid[]) ORDER BY approval_id, group_id`, targeted, groups); err != nil {
			return err
		}
	}
	causes := map[string][]string{}
	if len(canceled) > 0 {
		if err := collectPairs(ctx, tx, `
			SELECT DISTINCT ON (approval_id) approval_id::text, COALESCE(details->>'cause', '')
			  FROM approval_events
			 WHERE approval_id = ANY($1::uuid[]) AND event_type = 'canceled'
			 ORDER BY approval_id, occurred_at DESC`, canceled, causes); err != nil {
			return err
		}
	}
	for i := range recs {
		id := recs[i].ID
		if recs[i].Targeted() {
			recs[i].ApproverUserIDs = nonNil(users[id])
			recs[i].ApproverGroupIDs = nonNil(groups[id])
		}
		if c := causes[id]; len(c) == 1 && c[0] != "" {
			recs[i].CloseReasonDetails = map[string]any{"cause": c[0]}
		}
	}
	return nil
}

func collectPairs(ctx context.Context, tx pgx.Tx, q string, ids []string, into map[string][]string) error {
	rows, err := tx.Query(ctx, q, ids)
	if err != nil {
		return mapDBErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return mapDBErr(err)
		}
		into[k] = append(into[k], v)
	}
	return mapDBErr(rows.Err())
}

func nonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

// decideRouteTx is decide step 8 on a targeted row. The caller holds the
// approval row lock. The user snapshot is a plain read. Group membership
// goes through identity.InTargetGroups, which takes FOR SHARE on the
// matched membership row only. That is the only lock taken after the
// approval row: role bindings are never locked here, so this cannot form
// a cycle with RemoveMember (bindings, then group rows).
//
// A snapshot user or live group member decides via target. Otherwise an
// admin decides via admin_override; the requester never reaches here
// (self-approval is refused earlier). Anyone else is ErrApproverNotTargeted.
// A database error is ErrBindingTransient so the API answers 503.
func decideRouteTx(ctx context.Context, tx pgx.Tx, workspaceID string, rec Record, actorID string, roles []string) (string, error) {
	if slices.Contains(rec.ApproverUserIDs, actorID) {
		return ViaTarget, nil
	}
	if len(rec.ApproverGroupIDs) > 0 && actorID != "" {
		in, err := identity.InTargetGroups(ctx, tx, workspaceID, actorID, rec.ApproverGroupIDs)
		if err != nil {
			return "", fmt.Errorf("%w: approver groups", ErrBindingTransient)
		}
		if in {
			return ViaTarget, nil
		}
	}
	if slices.Contains(roles, "admin") {
		return ViaAdminOverride, nil
	}
	return "", ErrApproverNotTargeted
}

// insertOverrideAuditTx writes the audit row for an admin override in the
// decide transaction. Ids only.
func insertOverrideAuditTx(ctx context.Context, tx pgx.Tx, workspaceID, actorID string, rec Record, decision string) error {
	details, err := json.Marshal(map[string]string{
		"approvalId": rec.ID, "executionId": rec.ExecutionID, "nodeId": rec.NodeID, "decision": decision,
	})
	if err != nil {
		return ErrInvalid
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (workspace_id, actor_id, host_context_redacted, action, resource_type, resource_id, outcome, details_redacted)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, '{}'::jsonb, $3, 'approval', $4::uuid, $5, $6::jsonb)
	`, workspaceID, actorID, AuditDecidedByAdminOverride, rec.ID, decision, details)
	return mapDBErr(err)
}

// IsTargetedCaller reports, without locks, whether userID is a snapshot
// user or a live eligible member of a snapshot group. It backs the list
// filter and capabilities; decide stays authoritative. A machine
// principal is never targeted, even when an older snapshot names it.
func isTargetedCallerTx(ctx context.Context, tx pgx.Tx, workspaceID string, rec Record, userID string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	named := slices.Contains(rec.ApproverUserIDs, userID)
	if !named && len(rec.ApproverGroupIDs) == 0 {
		return false, nil
	}
	groups := rec.ApproverGroupIDs
	if groups == nil {
		groups = []string{}
	}
	var in bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
		    SELECT 1 FROM users u
		     WHERE u.id = $2::uuid AND u.issuer <> $5
		       AND ($4
		        OR (u.status = 'active'
		            AND EXISTS (SELECT 1 FROM workspace_group_members m
		                         WHERE m.workspace_id = $1::uuid AND m.user_id = u.id AND m.group_id = ANY($3::uuid[]))
		            AND EXISTS (SELECT 1 FROM workspace_role_bindings b WHERE b.workspace_id = $1::uuid AND b.user_id = u.id)))
		)`, workspaceID, userID, groups, named, parkedapproval.MachineIssuer).Scan(&in)
	if err != nil {
		return false, mapDBErr(err)
	}
	return in, nil
}
