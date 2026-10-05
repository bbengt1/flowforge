package localworker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

func TestPollOnceSkipsForbiddenWorkspace(t *testing.T) {
	api := &seqAPI{
		items: []identity.Membership{
			member("alpha", "one"),
			member("beta", "two"),
			member("gamma", "three"),
		},
		deny: map[string]bool{"beta/two": true},
	}
	r := NewRunner(api, Config{WorkerID: "local", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	n, err := r.PollOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("claimed = %d", n)
	}
	want := []string{"alpha/one", "beta/two", "gamma/three"}
	if len(api.seen) != len(want) {
		t.Fatalf("seen %v", api.seen)
	}
	for i := range want {
		if api.seen[i] != want[i] {
			t.Fatalf("seen %v", api.seen)
		}
	}
}

func TestPollOnceStopsOnOtherClaimError(t *testing.T) {
	api := &seqAPI{
		items: []identity.Membership{
			member("alpha", "one"),
			member("beta", "two"),
			member("gamma", "three"),
		},
		boom: map[string]bool{"beta/two": true},
	}
	r := NewRunner(api, Config{WorkerID: "local", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	_, err := r.PollOnce(context.Background())
	if err == nil {
		t.Fatal("expected claim error")
	}
	if errors.Is(err, ErrWorkspaceForbidden) {
		t.Fatal("non-403 must not be treated as a skip")
	}
	if len(api.seen) != 2 || api.seen[0] != "alpha/one" || api.seen[1] != "beta/two" {
		t.Fatalf("seen %v", api.seen)
	}
}

func TestClaimForbiddenOmitsBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "secret-body", http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)
	client := NewHTTP(HTTPConfig{BaseURL: srv.URL, Issuer: "https://idp.example", Subject: "worker"})
	_, err := client.Claim(context.Background(), "alpha", "one")
	if !errors.Is(err, ErrWorkspaceForbidden) {
		t.Fatalf("err = %v", err)
	}
	if errors.Unwrap(err) != nil || (err != nil && err.Error() != ErrWorkspaceForbidden.Error()) {
		t.Fatalf("error text = %q", err)
	}
}

func member(slug, key string) identity.Membership {
	return identity.Membership{
		Tenant:    identity.Tenant{Slug: slug},
		Workspace: identity.Workspace{ID: slug + "-id", WorkbenchKey: key},
	}
}

type seqAPI struct {
	items []identity.Membership
	deny  map[string]bool
	boom  map[string]bool
	seen  []string
}

func (a *seqAPI) Ready(context.Context) error { return nil }

func (a *seqAPI) ListMemberships(context.Context) ([]identity.Membership, error) {
	return a.items, nil
}

func (a *seqAPI) Claim(_ context.Context, slug, workbenchKey string) (*Claim, error) {
	id := slug + "/" + workbenchKey
	a.seen = append(a.seen, id)
	if a.boom[id] {
		return nil, errors.New("claim: 500")
	}
	if a.deny[id] {
		return nil, ErrWorkspaceForbidden
	}
	return nil, nil
}

func (a *seqAPI) Heartbeat(context.Context, string, string, Claim) error { return nil }
func (a *seqAPI) Complete(context.Context, string, string, Claim, map[string]any) error {
	return nil
}
func (a *seqAPI) Fail(context.Context, string, string, Claim, map[string]any) error { return nil }
