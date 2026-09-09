package scripts

import "net/http"

// VerifyForDispatch re-checks signature, scan, and mutability immediately
// before a runner may start. E9.2 must call this on every claim.
//
// TODO(E9.2): isolated runner — non-root, read-only rootfs, dropped
// capabilities, no_new_privs, no metadata/socket, controlled egress,
// approved runtime image + dependency lock.
//
// TODO(E9.3): typed I/O — validate input/output against declared schemas,
// inject only scoped credential handles, redact outputs before persist.
//
// TODO(E9.4): revocation / emergency-stop — re-check revoked_at before
// every dispatch; policy-gated stop that leaves uncertain outcomes
// indeterminate.
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

// RunnerNotImplemented is the E9.2 hook so execute paths fail closed
// rather than pretending a container ran.
func RunnerNotImplemented() error {
	return engineError(CodeRunnerNotImplemented, "Isolated script runners are not enabled (E9.2).", http.StatusNotImplemented)
}
