package wfstore

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// NormalizeFolderName trims and validates a folder display name.
func NormalizeFolderName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", ErrFolderName
	}
	for _, r := range name {
		if r == '/' || unicode.IsControl(r) {
			return "", ErrFolderName
		}
	}
	if folderNameGraphemes(name) < 1 || folderNameGraphemes(name) > MaxFolderNameGraphemes {
		return "", ErrFolderName
	}
	if utf8.RuneCountInString(name) > 256 {
		return "", ErrFolderName
	}
	return name, nil
}

func folderNameGraphemes(s string) int {
	n := 0
	prevRegional := false
	for _, r := range s {
		if r == '\u200d' {
			prevRegional = false
			continue
		}
		if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Mc, r) {
			prevRegional = false
			continue
		}
		if unicode.In(r, unicode.Variation_Selector) {
			continue
		}
		if r >= 0x1F1E6 && r <= 0x1F1FF {
			if prevRegional {
				prevRegional = false
				continue
			}
			prevRegional = true
			n++
			continue
		}
		prevRegional = false
		n++
	}
	return n
}

func sameFolderParent(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return strings.TrimSpace(*a) == strings.TrimSpace(*b)
}

func optionalID(id string) *string {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	out := id
	return &out
}

func cloneFolder(f Folder) Folder {
	out := f
	if f.ParentID != nil {
		p := *f.ParentID
		out.ParentID = &p
	}
	return out
}

func workflowMatchesFolder(wf Workflow, filter WorkflowListFilter) bool {
	if filter.Unfiled {
		return wf.FolderID == nil || strings.TrimSpace(*wf.FolderID) == ""
	}
	if strings.TrimSpace(filter.FolderID) == "" {
		return true
	}
	return wf.FolderID != nil && *wf.FolderID == strings.TrimSpace(filter.FolderID)
}
