package scripts

import "net/http"

// VerifyForDispatch re-checks signature, scan, and mutability immediately
// before a runner may start. Execute calls this on every run.
//
// Typed I/O (E9.3) and revocation/emergency-stop (E9.4) remain hooks:
// revoked_at is already fail-closed here; emergency stop is not implemented.
func VerifyForDispatch(art Artifact, key []byte) error {
	if art.Status != StatusPublished {
		return ErrMutable
	}
	if art.RevokedAt != nil && !art.RevokedAt.IsZero() {
		return ErrRevoked
	}
	switch art.ScanStatus {
	case ScanClean:
	case ScanFailed:
		return ErrScanFailed
	case ScanPending, "":
		return ErrUnscanned
	case ScanUnsigned:
		return ErrUnsigned
	default:
		return ErrUnscanned
	}
	if stringsBlank(art.Signature) || !stringsHasPrefix(art.Signature, SignaturePrefix) {
		return ErrUnsigned
	}
	if !VerifySignature(key, art.Digest, art.Signature) {
		return ErrUnsigned
	}
	return nil
}

func stringsBlank(s string) bool {
	for _, r := range s {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}

func stringsHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// RunnerNotImplemented remains for callers that explicitly require a live
// container runtime (RequireLiveRuntime). The default path is Execute +
// HarnessRuntime, which enforces every isolation gate in CI.
func RunnerNotImplemented() error {
	return engineError(CodeRunnerNotImplemented, "Live container runtime is not available in this process (CI harness).", http.StatusNotImplemented)
}
