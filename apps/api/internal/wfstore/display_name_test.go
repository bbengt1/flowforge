package wfstore

import (
	"context"
	"errors"
	"testing"
)

func TestPersistRejectsSeparatorDisplayName(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := testWorkflowScope(t)
	in := displayNameCreateInput(t, "")

	cases := []struct {
		name  string
		title string
	}{
		{name: "zero-width space", title: "Deploy\u200bAPI"},
		{name: "right-to-left override", title: "Deploy\u202eAPI"},
		{name: "line separator", title: "Deploy\u2028API"},
		{name: "paragraph separator", title: "Deploy\u2029API"},
		{name: "byte order mark", title: "\ufeffDeploy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			created := in
			created.Name = tc.title
			if _, _, err := store.Create(ctx, scope, created); !errors.Is(err, ErrInvalid) {
				t.Fatalf("create override: %v", err)
			}
		})
	}

	in.Name = ""
	wf, _, err := store.Create(ctx, scope, in)
	if err != nil {
		t.Fatal(err)
	}
	bad := in.Summary
	bad.Name = "Rename\u2028Title"
	if _, _, err := store.SaveDraft(ctx, scope, wf.ID, SaveInput{
		ExpectedRevision: 1,
		NormalizedYAML:   in.NormalizedYAML,
		Digest:           in.Digest,
		Summary:          bad,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("save: %v", err)
	}
}
