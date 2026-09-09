package kubernetes

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// FakeClient is an in-memory ClusterClient for unit tests.
// It models server-side dry-run (no persist) and SSA with Force=false.
//
// TODO(envtest): add controller-runtime envtest coverage for API discovery,
// server-side dry-run, and real SSA ownership conflicts once CI can fetch
// kube-apiserver binaries. These fake-client tests cover the same contracts.
type FakeClient struct {
	mu      sync.Mutex
	objects map[string]*fakeObject
	// Deny is invoked before get/list/apply. Return an error to simulate RBAC.
	Deny func(verb, kind, namespace, name string) error
	// DryRuns counts successful server-side dry-run applies.
	DryRuns int
	// Applies counts successful persistent applies.
	Applies int
}

type fakeObject struct {
	obj      Unstructured
	managers map[string][]string
}

// NewFakeClient returns an empty fake cluster.
func NewFakeClient() *FakeClient {
	return &FakeClient{objects: map[string]*fakeObject{}}
}

// Seed puts an object under a field manager (for conflict tests).
func (f *FakeClient) Seed(obj Unstructured, manager string) {
	f.SeedOwned(obj, manager, nil)
}

// SeedOwned records explicit SSA field paths owned by manager.
func (f *FakeClient) SeedOwned(obj Unstructured, manager string, paths []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.objects == nil {
		f.objects = map[string]*fakeObject{}
	}
	id := objectKey(obj)
	if len(paths) == 0 {
		paths = collectFieldPaths(obj, "")
	}
	f.objects[id] = &fakeObject{
		obj:      cloneUnstructured(obj),
		managers: map[string][]string{manager: append([]string(nil), paths...)},
	}
}

func (f *FakeClient) Apply(ctx context.Context, obj Unstructured, opts ApplyOptions) (Unstructured, error) {
	if err := ctx.Err(); err != nil {
		return nil, engineError(CodeTimeout, "context canceled", http.StatusRequestTimeout)
	}
	kind, _ := obj["kind"].(string)
	meta, _ := asStringKeyMap(obj["metadata"])
	name, _ := meta["name"].(string)
	ns, _ := meta["namespace"].(string)
	if f.Deny != nil {
		if err := f.Deny("apply", kind, ns, name); err != nil {
			return nil, err
		}
	}
	manager := strings.TrimSpace(opts.FieldManager)
	if manager == "" {
		manager = FieldManager
	}
	if opts.Force {
		return nil, engineError(CodeOwnershipConflict, "force apply is not allowed", http.StatusConflict)
	}
	paths := collectFieldPaths(obj, "")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.objects == nil {
		f.objects = map[string]*fakeObject{}
	}
	id := objectKey(obj)
	existing, ok := f.objects[id]
	if ok {
		for other, owned := range existing.managers {
			if other == manager {
				continue
			}
			if overlap(owned, paths) {
				return nil, engineError(CodeOwnershipConflict, fmt.Sprintf("field manager %q already owns one or more fields; Force=false", other), http.StatusConflict)
			}
		}
	}
	applied := cloneUnstructured(obj)
	if meta, ok := asStringKeyMap(applied["metadata"]); ok {
		gen := int64(1)
		if ok && existing != nil {
			if prev, _ := asStringKeyMap(existing.obj["metadata"]); prev != nil {
				if n, has := intField(prev, "generation"); has {
					gen = n + 1
				}
			}
		}
		meta["generation"] = gen
		applied["metadata"] = meta
	}
	if opts.DryRun {
		f.DryRuns++
		return applied, nil
	}
	stored := existing
	if stored == nil {
		stored = &fakeObject{managers: map[string][]string{}}
	}
	if stored.obj != nil {
		applied = mergeUnstructured(stored.obj, applied)
	}
	stored.obj = applied
	stored.managers[manager] = union(stored.managers[manager], paths)
	f.objects[id] = stored
	f.Applies++
	return cloneUnstructured(applied), nil
}

func (f *FakeClient) Get(_ context.Context, kind, namespace, name string) (Unstructured, error) {
	if f.Deny != nil {
		if err := f.Deny("get", kind, namespace, name); err != nil {
			return nil, err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	obj, ok := f.objects[keyFor(kind, namespace, name)]
	if !ok {
		return nil, engineError(CodeReadFailed, "resource not found", http.StatusNotFound)
	}
	return cloneUnstructured(obj.obj), nil
}

func (f *FakeClient) List(_ context.Context, kind, namespace string, _ ListOptions) ([]Unstructured, error) {
	if f.Deny != nil {
		if err := f.Deny("list", kind, namespace, ""); err != nil {
			return nil, err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Unstructured
	prefix := strings.ToLower(kind) + "/" + namespace + "/"
	for id, obj := range f.objects {
		if !strings.HasPrefix(id, prefix) {
			continue
		}
		out = append(out, cloneUnstructured(obj.obj))
	}
	sort.Slice(out, func(i, j int) bool {
		return identityOf(out[i]).Name < identityOf(out[j]).Name
	})
	return out, nil
}

func objectKey(obj Unstructured) string {
	kind, _ := obj["kind"].(string)
	meta, _ := asStringKeyMap(obj["metadata"])
	name, _ := meta["name"].(string)
	ns, _ := meta["namespace"].(string)
	return keyFor(kind, ns, name)
}

func keyFor(kind, ns, name string) string {
	return strings.ToLower(strings.TrimSpace(kind)) + "/" + strings.TrimSpace(ns) + "/" + strings.TrimSpace(name)
}

func collectFieldPaths(v any, prefix string) []string {
	if u, ok := v.(Unstructured); ok {
		v = map[string]any(u)
	}
	var out []string
	switch t := v.(type) {
	case map[string]any:
		if len(t) == 0 {
			if prefix != "" {
				out = append(out, prefix)
			}
			return out
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			child := t[k]
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			out = append(out, collectFieldPaths(child, p)...)
		}
	case []any:
		if prefix != "" {
			out = append(out, prefix)
		}
	default:
		if prefix != "" {
			out = append(out, prefix)
		}
	}
	return out
}

func overlap(a, b []string) bool {
	seen := map[string]struct{}{}
	for _, p := range a {
		seen[p] = struct{}{}
	}
	for _, p := range b {
		if _, ok := seen[p]; ok {
			return true
		}
	}
	return false
}

func union(a, b []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, p := range append(append([]string{}, a...), b...) {
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func cloneUnstructured(in Unstructured) Unstructured {
	if in == nil {
		return nil
	}
	copied := convertYAML(map[string]any(in))
	if m, ok := copied.(map[string]any); ok {
		return m
	}
	return nil
}

func mergeUnstructured(base, overlay Unstructured) Unstructured {
	out := cloneUnstructured(base)
	if out == nil {
		return cloneUnstructured(overlay)
	}
	mergeMap(out, overlay)
	return out
}

func mergeMap(dst, src map[string]any) {
	for k, v := range src {
		if dm, ok := dst[k].(map[string]any); ok {
			if sm, ok := v.(map[string]any); ok {
				mergeMap(dm, sm)
				continue
			}
		}
		dst[k] = convertYAML(v)
	}
}
