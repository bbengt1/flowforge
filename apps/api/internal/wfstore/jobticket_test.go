package wfstore

import (
	"strings"
	"testing"
	"time"
)

func TestJobTicketRejectsAlteredExpiredAndCrossWorkspace(t *testing.T) {
	key := NewJobBindingKey()
	now := time.Date(2026, 9, 9, 3, 0, 0, 0, time.UTC)
	binding := JobBinding{
		WorkspaceID:       "11111111-1111-4111-8111-111111111111",
		ExecutionID:       "22222222-2222-4222-8222-222222222222",
		JobID:             "33333333-3333-4333-8333-333333333333",
		StepID:            "44444444-4444-4444-8444-444444444444",
		WorkflowID:        "55555555-5555-4555-8555-555555555555",
		WorkflowVersionID: "66666666-6666-4666-8666-666666666666",
		WorkflowDigest:    "sha256:" + strings.Repeat("ab", 32),
		PolicyDigest:      "sha256:" + strings.Repeat("cd", 32),
		FencingToken:      2,
		ExpiresAt:         now.Add(time.Hour),
		LeaseExpiresAt:    now.Add(30 * time.Second),
		CorrelationID:     "corr-1",
	}
	token, err := SignJobTicket(key, binding)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseJobTicket(key, token)
	if err != nil {
		t.Fatal(err)
	}
	if got.JobID != binding.JobID || got.FencingToken != 2 {
		t.Fatalf("round-trip = %+v", got)
	}
	if err := AuthorizeJobBinding(got, binding.WorkspaceID, binding.WorkflowVersionID, binding.WorkflowDigest, now); err != nil {
		t.Fatalf("authorize: %v", err)
	}

	dot := strings.LastIndex(token, ".")
	if dot < 0 || dot+2 >= len(token) {
		t.Fatalf("token shape: %s", token)
	}
	// Flip a signature character that is not trailing base64 leftover bits.
	sig := []byte(token[dot+1:])
	if sig[0] == 'A' {
		sig[0] = 'B'
	} else {
		sig[0] = 'A'
	}
	altered := token[:dot+1] + string(sig)
	if _, err := ParseJobTicket(key, altered); err != ErrJobBinding {
		t.Fatalf("altered token: %v", err)
	}
	if err := AuthorizeJobBinding(got, "99999999-9999-4999-8999-999999999999", "", "", now); err != ErrJobBinding {
		t.Fatalf("cross-workspace: %v", err)
	}
	if err := AuthorizeJobBinding(got, binding.WorkspaceID, "", "", now.Add(2*time.Hour)); err != ErrJobExpired {
		t.Fatalf("expired: %v", err)
	}
	wrongDigest := got
	wrongDigest.WorkflowDigest = "sha256:" + strings.Repeat("00", 32)
	if err := AuthorizeJobBinding(wrongDigest, binding.WorkspaceID, "", binding.WorkflowDigest, now); err != ErrJobBinding {
		t.Fatalf("altered digest: %v", err)
	}

	bound := binding
	bound.TenantID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	bound.WorkbenchKey = "ops"
	v2, err := SignJobTicket(key, bound)
	if err != nil {
		t.Fatal(err)
	}
	gotV2, err := ParseJobTicket(key, v2)
	if err != nil {
		t.Fatal(err)
	}
	if gotV2.TenantID != bound.TenantID || gotV2.WorkbenchKey != "ops" {
		t.Fatalf("v2 tenancy %+v", gotV2)
	}
}
