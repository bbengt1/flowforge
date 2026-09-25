package wfstore

import (
	"context"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const (
	workflowSlugFallback   = "workflow"
	maxWorkflowSlugLen     = 63
	maxDerivedSlugAttempts = 20
)

// SlugChoice is the slug a create will try first. Derived is true when the
// slug came from the display name and may gain a numeric suffix. An explicit
// slug, from the request body or from metadata.slug, is never rewritten.
type SlugChoice struct {
	Slug    string
	Derived bool
}

// ChooseCreateSlug applies create precedence: body slug, then a slug written
// in the YAML, then a slug derived from the display name. An explicit slug
// that fails workflow slug validation, including a reserved word, is rejected.
func ChooseCreateSlug(bodySlug, yamlSlug, name string) (SlugChoice, error) {
	if slug := strings.TrimSpace(bodySlug); slug != "" {
		if !workflow.ValidWorkflowSlug(slug) {
			return SlugChoice{}, ErrInvalid
		}
		return SlugChoice{Slug: slug, Derived: false}, nil
	}
	if slug := strings.TrimSpace(yamlSlug); slug != "" {
		if !workflow.ValidWorkflowSlug(slug) {
			return SlugChoice{}, ErrInvalid
		}
		return SlugChoice{Slug: slug, Derived: false}, nil
	}
	return SlugChoice{Slug: slugifyWorkflowName(name), Derived: true}, nil
}

func resolveCreateSlug(in CreateInput) (SlugChoice, error) {
	if in.SlugDerived {
		slug := strings.TrimSpace(in.Slug)
		if slug == "" {
			slug = slugifyWorkflowName(createDisplayName(in))
		}
		if !authz.ValidTenantSlug(slug) {
			return SlugChoice{}, ErrInvalid
		}
		return SlugChoice{Slug: slug, Derived: true}, nil
	}
	if slug := strings.TrimSpace(in.Slug); slug != "" {
		return ChooseCreateSlug(slug, "", createDisplayName(in))
	}
	yamlSlug, err := metadataSlug(in.NormalizedYAML)
	if err != nil {
		return SlugChoice{}, err
	}
	return ChooseCreateSlug("", yamlSlug, createDisplayName(in))
}

func createDisplayName(in CreateInput) string {
	if name := strings.TrimSpace(in.Name); name != "" {
		return name
	}
	return strings.TrimSpace(in.Summary.Name)
}

func metadataSlug(yamlDoc string) (string, error) {
	doc, errs := workflow.Parse([]byte(yamlDoc))
	if len(errs) > 0 || doc == nil {
		return "", ErrInvalid
	}
	return doc.Metadata.Slug, nil
}

// stampWorkflowSlug writes slug into metadata.slug and re-normalizes so the
// stored YAML stays the source of truth for the slug that was inserted.
func stampWorkflowSlug(yamlDoc, slug string) (string, string, workflow.Summary, error) {
	doc, errs := workflow.Parse([]byte(yamlDoc))
	if len(errs) > 0 || doc == nil {
		return "", "", workflow.Summary{}, ErrInvalid
	}
	doc.Metadata.Slug = slug
	normalized, digest, err := workflow.Normalize(doc)
	if err != nil {
		return "", "", workflow.Summary{}, ErrInvalid
	}
	return normalized, digest, doc.Summary(), nil
}

// slugCandidates is the insert sequence. A derived slug retries with -2, -3,
// and so on. A reserved derived base is treated as already taken. An explicit
// slug is a single candidate.
func slugCandidates(choice SlugChoice) ([]string, error) {
	if !choice.Derived {
		if !workflow.ValidWorkflowSlug(choice.Slug) {
			return nil, ErrInvalid
		}
		return []string{choice.Slug}, nil
	}
	if !authz.ValidTenantSlug(choice.Slug) {
		return nil, ErrInvalid
	}
	start := 1
	if workflow.ReservedWorkflowSlug(choice.Slug) {
		start = 2
	}
	out := make([]string, 0, maxDerivedSlugAttempts)
	for n := start; len(out) < maxDerivedSlugAttempts; n++ {
		candidate, ok := workflowSlugCandidate(choice.Slug, n)
		if !ok {
			break
		}
		if workflow.ReservedWorkflowSlug(candidate) || !workflow.ValidWorkflowSlug(candidate) {
			continue
		}
		out = append(out, candidate)
	}
	if len(out) == 0 {
		return nil, ErrInvalid
	}
	return out, nil
}

func workflowSlugCandidate(base string, n int) (string, bool) {
	if n < 1 {
		return "", false
	}
	if n == 1 {
		return base, authz.ValidTenantSlug(base)
	}
	suffix := "-" + strconv.Itoa(n)
	if len(suffix) >= maxWorkflowSlugLen {
		return "", false
	}
	head := base
	room := maxWorkflowSlugLen - len(suffix)
	if len(head) > room {
		head = head[:room]
	}
	head = strings.TrimRight(head, "-")
	if head == "" {
		return "", false
	}
	candidate := head + suffix
	return candidate, authz.ValidTenantSlug(candidate)
}

// slugifyWorkflowName turns a display title into a stored slug
// (^[a-z][a-z0-9-]{0,62}$). A leading digit is prefixed with w- so the
// result matches that format. Titles with no usable characters become
// workflowSlugFallback. Reserved words are left in place; create treats
// them as a clash and suffixes them.
func slugifyWorkflowName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	lastHyphen := true
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastHyphen = false
			continue
		}
		if !lastHyphen {
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return workflowSlugFallback
	}
	if out[0] >= '0' && out[0] <= '9' {
		out = "w-" + out
	}
	if len(out) > maxWorkflowSlugLen {
		out = strings.TrimRight(out[:maxWorkflowSlugLen], "-")
	}
	if !validDerivedWorkflowSlug(out) {
		return workflowSlugFallback
	}
	return out
}

func validDerivedWorkflowSlug(s string) bool {
	if len(s) < 1 || len(s) > maxWorkflowSlugLen {
		return false
	}
	if s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			continue
		}
		return false
	}
	return s[len(s)-1] != '-'
}

type slugInsertHookKey struct{}

// withSlugInsertHook runs hook immediately before each slug insert attempt.
// Tests use it to overlap two creates on the same derived slug. The hook
// must not re-enter Create on the calling goroutine.
func withSlugInsertHook(ctx context.Context, hook func(attempt int, slug string)) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, slugInsertHookKey{}, hook)
}

func runSlugInsertHook(ctx context.Context, attempt int, slug string) {
	if ctx == nil {
		return
	}
	hook, _ := ctx.Value(slugInsertHookKey{}).(func(int, string))
	if hook != nil {
		hook(attempt, slug)
	}
}
