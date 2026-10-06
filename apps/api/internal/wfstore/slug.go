package wfstore

import (
	"context"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const (
	workflowSlugFallback = "workflow"
	maxWorkflowSlugLen   = 63
	// maxDerivedSlugRetries bounds how often a derived create recomputes
	// the next suffix after losing a unique-index race. Losing every time
	// returns a live SlugConflict (409 workflow_slug_taken).
	maxDerivedSlugRetries = 8
	// maxSlugSuffix caps the numeric suffix a slug match will parse. A
	// longer run of digits is not treated as a suffix.
	maxSlugSuffix = 999999999
	// minSuffixHead is the shortest head a capped base keeps in front of
	// a suffix up to maxSlugSuffix: 63 - len("-999999999").
	minSuffixHead = maxWorkflowSlugLen - 10
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
// that fails the new-slug check, including a reserved word, a trailing
// hyphen, or a double hyphen, is rejected. Create and import share this.
func ChooseCreateSlug(bodySlug, yamlSlug, name string) (SlugChoice, error) {
	if slug := strings.TrimSpace(bodySlug); slug != "" {
		if !workflow.ValidNewWorkflowSlug(slug) {
			return SlugChoice{}, ErrInvalid
		}
		return SlugChoice{Slug: slug, Derived: false}, nil
	}
	if slug := strings.TrimSpace(yamlSlug); slug != "" {
		if !workflow.ValidNewWorkflowSlug(slug) {
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
		if !workflow.NewWorkflowSlugShape(slug) {
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
// The digest and summary come from that same normalization.
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

// draftSlugForSave decides metadata.slug for a draft save. stored is the
// workflow row slug, which never changes after create. previous is
// metadata.slug in the draft being replaced. incoming is metadata.slug in
// the submitted YAML. A missing or unchanged incoming slug is replaced
// with stored. An incoming slug equal to stored is accepted, because the
// result is the same. Any other change is ErrSlugImmutable. The stored
// slug is compared, never re-validated.
func draftSlugForSave(stored, previous, incoming string) error {
	incoming = strings.TrimSpace(incoming)
	if incoming == "" || incoming == stored || incoming == strings.TrimSpace(previous) {
		return nil
	}
	return ErrSlugImmutable
}

// stampSavedDraft applies draftSlugForSave and returns the YAML, digest,
// and summary to persist, all from one normalization.
func stampSavedDraft(in SaveInput, stored, previousYAML string) (string, string, workflow.Summary, error) {
	incoming, err := metadataSlug(in.NormalizedYAML)
	if err != nil {
		return "", "", workflow.Summary{}, err
	}
	previous, perr := metadataSlug(previousYAML)
	if perr != nil {
		previous = ""
	}
	if err := draftSlugForSave(stored, previous, incoming); err != nil {
		return "", "", workflow.Summary{}, err
	}
	if incoming == stored {
		return in.NormalizedYAML, in.Digest, in.Summary, nil
	}
	return stampWorkflowSlug(in.NormalizedYAML, stored)
}

// slugMatchPrefix is a prefix every slug in the base family starts with:
// base itself and each base-N built by workflowSlugCandidate for N up to
// maxSlugSuffix. It only narrows the query. slugSuffixFor decides.
func slugMatchPrefix(base string) string {
	if len(base) <= minSuffixHead {
		return base
	}
	return strings.TrimRight(base[:minSuffixHead], "-")
}

// slugSuffixFor reports n when slug is exactly workflowSlugCandidate(base, n).
// base itself is n = 1. A slug that only shares a prefix, such as x-2-3
// for base x, does not match. This is an exact parse, not a pattern match.
func slugSuffixFor(base, slug string) (int, bool) {
	if slug == base {
		return 1, true
	}
	i := strings.LastIndexByte(slug, '-')
	if i < 1 || i == len(slug)-1 {
		return 0, false
	}
	digits := slug[i+1:]
	if len(digits) > 9 || digits[0] == '0' {
		return 0, false
	}
	n := 0
	for _, c := range digits {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	if n < 2 || n > maxSlugSuffix {
		return 0, false
	}
	want, ok := workflowSlugCandidate(base, n)
	if !ok || want != slug {
		return 0, false
	}
	return n, true
}

// nextDerivedSlug returns the slug after the highest suffix already used
// for base, live or deleted. used may hold unrelated slugs; only exact
// family members count. A reserved or invalid candidate is skipped.
func nextDerivedSlug(base string, used []string) (string, bool) {
	if !workflow.NewWorkflowSlugShape(base) {
		return "", false
	}
	highest := 0
	for _, slug := range used {
		if n, ok := slugSuffixFor(base, slug); ok && n > highest {
			highest = n
		}
	}
	taken := make(map[string]bool, len(used))
	for _, slug := range used {
		taken[slug] = true
	}
	for n := highest + 1; n <= maxSlugSuffix && n <= highest+100; n++ {
		candidate, ok := workflowSlugCandidate(base, n)
		if !ok {
			return "", false
		}
		if taken[candidate] || !workflow.ValidNewWorkflowSlug(candidate) {
			continue
		}
		return candidate, true
	}
	return "", false
}

// suggestionBase is the base a slug 409 builds suggestedSlug from. One
// trailing -N (N >= 2) is dropped when what is left is still a valid new
// slug shape, so orders-2 suggests from orders. Otherwise the slug itself.
func suggestionBase(slug string) string {
	i := strings.LastIndexByte(slug, '-')
	if i < 1 {
		return slug
	}
	head := slug[:i]
	if _, ok := slugSuffixFor(head, slug); ok && workflow.NewWorkflowSlugShape(head) {
		return head
	}
	return slug
}

// suggestSlug builds suggestedSlug for a clash on slug from the slugs
// already used in the workspace. Empty means none could be built.
func suggestSlug(slug string, used []string) string {
	next, ok := nextDerivedSlug(suggestionBase(slug), used)
	if !ok {
		return ""
	}
	return next
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
