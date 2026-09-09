package ssh

import (
	"encoding/base64"
	"encoding/hex"
	"net"
	"regexp"
	"strings"
)

var deniedUsernames = map[string]bool{
	"root":          true,
	"toor":          true,
	"administrator": true,
}

var (
	hostnameRE     = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$`)
	hexFingerprint = regexp.MustCompile(`^[0-9a-f]{64}$`)
	b64Fingerprint = regexp.MustCompile(`^[A-Za-z0-9+/]{43}$`)
	usernameRE     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`)
)

const defaultPort = 22

// NormalizeHostname lowercases a DNS name or canonicalizes a literal IP.
func NormalizeHostname(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", wrapInvalid("hostname is required")
	}
	if len(host) > 253 {
		return "", wrapInvalid("hostname is not a valid host or IP")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			return "", wrapInvalid("hostname cannot be an unspecified address")
		}
		return ip.String(), nil
	}
	if !hostnameRE.MatchString(host) {
		return "", wrapInvalid("hostname is not a valid host or IP")
	}
	return strings.ToLower(host), nil
}

// NormalizePort returns 22 when omitted. Values must be 1–65535.
func NormalizePort(raw any, present bool) (int, error) {
	if !present {
		return defaultPort, nil
	}
	n, err := asInt(raw)
	if err != nil || n < 1 || n > 65535 {
		return 0, wrapInvalid("port must be 1-65535")
	}
	return n, nil
}

// NormalizeFingerprint accepts FlowForge sha256:<64 hex> or OpenSSH SHA256:<base64>.
// Hex forms canonicalize to lowercase without colons.
func NormalizeFingerprint(fp string) (string, error) {
	fp = strings.TrimSpace(fp)
	if fp == "" {
		return "", wrapInvalid("hostKeyFingerprint is required")
	}
	lower := strings.ToLower(fp)
	switch {
	case strings.HasPrefix(lower, "sha256:"):
		rest := strings.TrimPrefix(lower, "sha256:")
		compact := strings.ReplaceAll(rest, ":", "")
		if hexFingerprint.MatchString(compact) {
			return "sha256:" + compact, nil
		}
		// OpenSSH base64 is case-sensitive; re-read the original suffix.
		orig := strings.TrimSpace(fp)
		idx := strings.Index(orig, ":")
		if idx < 0 {
			return "", wrapInvalid("hostKeyFingerprint must be sha256:<hex> or SHA256:<base64>")
		}
		b64 := orig[idx+1:]
		if !b64Fingerprint.MatchString(b64) {
			return "", wrapInvalid("hostKeyFingerprint must be sha256:<hex> or SHA256:<base64>")
		}
		raw, err := base64.RawStdEncoding.DecodeString(b64)
		if err != nil || len(raw) != 32 {
			return "", wrapInvalid("hostKeyFingerprint must be sha256:<hex> or SHA256:<base64>")
		}
		return "sha256:" + hex.EncodeToString(raw), nil
	default:
		return "", wrapInvalid("hostKeyFingerprint must be sha256:<hex> or SHA256:<base64>")
	}
}

// NormalizeAddresses validates IP/CIDR allowlist members. A present empty
// list fails closed. Default-route CIDRs and unspecified addresses are rejected.
func NormalizeAddresses(items []string, present bool) ([]string, error) {
	if !present {
		return nil, nil
	}
	if len(items) == 0 {
		return nil, wrapInvalid("allowedAddresses must not be empty (deny-by-default)")
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		canon, err := normalizeAddress(item)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[canon]; dup {
			continue
		}
		seen[canon] = struct{}{}
		out = append(out, canon)
	}
	if len(out) == 0 {
		return nil, wrapInvalid("allowedAddresses must not be empty (deny-by-default)")
	}
	return out, nil
}

func normalizeAddress(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", wrapInvalid("allowedAddresses contains an invalid value")
	}
	if ip := net.ParseIP(raw); ip != nil {
		if ip.IsUnspecified() {
			return "", wrapInvalid("allowedAddresses cannot include unspecified addresses")
		}
		return ip.String(), nil
	}
	_, network, err := net.ParseCIDR(raw)
	if err != nil {
		return "", wrapInvalid("allowedAddresses must be IP addresses or CIDR prefixes")
	}
	ones, bits := network.Mask.Size()
	if ones == 0 {
		return "", wrapInvalid("allowedAddresses cannot include a default-route CIDR")
	}
	if ones == bits {
		ip := network.IP
		if ip.IsUnspecified() {
			return "", wrapInvalid("allowedAddresses cannot include unspecified addresses")
		}
	}
	return network.String(), nil
}

// ValidHostname reports whether host is a DNS name or IP literal.
func ValidHostname(host string) bool {
	_, err := NormalizeHostname(host)
	return err == nil
}

// NormalizeUsername returns the default non-root account when omitted.
// root / toor / administrator / admin are rejected.
func NormalizeUsername(raw string, present bool) (string, error) {
	if !present || strings.TrimSpace(raw) == "" {
		return DefaultUsername, nil
	}
	user := strings.TrimSpace(raw)
	if !usernameRE.MatchString(user) {
		return "", wrapInvalid("username is not a valid remote account")
	}
	if isDeniedUsername(user) {
		return "", wrapInvalid("remote account must not be root")
	}
	return user, nil
}

func isDeniedUsername(user string) bool {
	return deniedUsernames[strings.ToLower(strings.TrimSpace(user))]
}
