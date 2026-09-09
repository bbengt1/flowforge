package scripts

import (
	"net/http"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	pythonEntrypointRE = regexp.MustCompile(`^[A-Za-z_][\w-]*\.py$`)
	goFileEntrypointRE = regexp.MustCompile(`^[A-Za-z_][\w-]*\.go$`)
	goSymbolRE         = regexp.MustCompile(`^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$`)
	goPackageRE        = regexp.MustCompile(`(?m)^package\s+[A-Za-z_]\w*`)
)

// ValidateSource checks language-specific source and entrypoint rules.
func ValidateSource(language, source, entrypoint string) error {
	language = strings.ToLower(strings.TrimSpace(language))
	if language != LanguagePython && language != LanguageGo {
		return engineError(CodeInvalidSource, "language must be python or go.", http.StatusBadRequest)
	}
	if strings.ContainsRune(source, 0) || !utf8.ValidString(source) {
		return engineError(CodeInvalidSource, "source must be valid UTF-8 without NUL bytes.", http.StatusBadRequest)
	}
	src := strings.TrimSpace(source)
	if src == "" {
		return engineError(CodeInvalidSource, "source is required.", http.StatusBadRequest)
	}
	if len(source) > MaxSourceBytes {
		return engineError(CodeSizeLimit, "source exceeds the 64 KiB limit.", http.StatusBadRequest)
	}
	if err := ValidateEntrypoint(language, entrypoint); err != nil {
		return err
	}
	if language == LanguageGo && !goPackageRE.MatchString(source) {
		return engineError(CodeInvalidSource, "Go source must declare a package.", http.StatusBadRequest)
	}
	return nil
}

// ValidateEntrypoint rejects path traversal, absolute paths, and language mismatch.
func ValidateEntrypoint(language, entrypoint string) error {
	entrypoint = strings.TrimSpace(entrypoint)
	if entrypoint == "" {
		return engineError(CodeInvalidEntrypoint, "entrypoint is required.", http.StatusBadRequest)
	}
	if len(entrypoint) > MaxEntrypointBytes {
		return engineError(CodeSizeLimit, "entrypoint exceeds the length limit.", http.StatusBadRequest)
	}
	if strings.Contains(entrypoint, "\\") || strings.Contains(entrypoint, "/") || strings.Contains(entrypoint, "..") {
		return engineError(CodeInvalidEntrypoint, "entrypoint must be a basename (no path separators).", http.StatusBadRequest)
	}
	base := path.Base(entrypoint)
	if base != entrypoint || base == "." || base == ".." {
		return engineError(CodeInvalidEntrypoint, "entrypoint must be a basename.", http.StatusBadRequest)
	}
	switch strings.ToLower(strings.TrimSpace(language)) {
	case LanguagePython:
		if !pythonEntrypointRE.MatchString(entrypoint) {
			return engineError(CodeInvalidEntrypoint, "Python entrypoint must be a .py basename such as main.py.", http.StatusBadRequest)
		}
	case LanguageGo:
		if !goFileEntrypointRE.MatchString(entrypoint) && !goSymbolRE.MatchString(entrypoint) {
			return engineError(CodeInvalidEntrypoint, "Go entrypoint must be a .go basename or a package.Function symbol.", http.StatusBadRequest)
		}
	default:
		return engineError(CodeInvalidSource, "language must be python or go.", http.StatusBadRequest)
	}
	return nil
}
