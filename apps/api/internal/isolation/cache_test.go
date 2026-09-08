package isolation

import "testing"

func TestCacheIsWorkspaceScoped(t *testing.T) {
	c := NewCache()
	a, err := Authorize("11111111-1111-1111-1111-111111111111", "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Authorize("22222222-2222-2222-2222-222222222222", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Set(a, "job:1", "payload-a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Get(b, "job:1"); ok {
		t.Fatal("cache leaked across workspaces")
	}
	if _, ok := c.Get(Scope{}, "job:1"); ok {
		t.Fatal("unset scope must miss")
	}
	got, ok := c.Get(a, "job:1")
	if !ok || got != "payload-a" {
		t.Fatalf("got %q ok=%v", got, ok)
	}
}
