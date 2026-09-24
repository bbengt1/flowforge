package wfstore

import "strings"

const workflowSlugFallback = "workflow"

// workflowSlug keeps a caller-supplied slug. An omitted slug is derived from
// the human display name as a DNS label, independent of that title.
func workflowSlug(explicit, displayName string) string {
	if slug := strings.TrimSpace(explicit); slug != "" {
		return slug
	}
	return slugifyWorkflowName(displayName)
}

// slugifyWorkflowName turns a display title into a DNS label
// (^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$). Titles with no usable characters
// become workflowSlugFallback.
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
	if len(out) > 63 {
		out = strings.Trim(out[:63], "-")
	}
	if !validDerivedWorkflowSlug(out) {
		return workflowSlugFallback
	}
	return out
}

func validDerivedWorkflowSlug(s string) bool {
	if len(s) < 1 || len(s) > 63 {
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
