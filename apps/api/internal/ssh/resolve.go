package ssh

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// Resolver is the approved hostname lookup. Implementations must not
// connect and must return every address the name resolves to.
type Resolver interface {
	LookupIP(ctx context.Context, network, host string) ([]net.IP, error)
}

// SystemResolver uses the process default resolver (no custom nameservers).
type SystemResolver struct{}

// LookupIP implements Resolver.
func (SystemResolver) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	if network == "" {
		network = "ip"
	}
	return net.DefaultResolver.LookupIP(ctx, network, host)
}

// ResolveResult is a verified, allowlisted set of addresses.
type ResolveResult struct {
	Hostname  string
	Addresses []net.IP
	DialIP    net.IP
}

// ResolveHostname looks up host through resolver. IP literals skip DNS.
// Every returned address must later pass AddressAllowed.
func ResolveHostname(ctx context.Context, resolver Resolver, host string) (ResolveResult, *EngineError) {
	host = strings.TrimSpace(host)
	if host == "" {
		return ResolveResult{}, engineError(CodeInvalidTarget, "hostname is required", http.StatusBadRequest)
	}
	canon, err := NormalizeHostname(host)
	if err != nil {
		return ResolveResult{}, engineError(CodeInvalidTarget, "hostname is not a valid host or IP", http.StatusBadRequest)
	}
	if ip := net.ParseIP(canon); ip != nil {
		if ip.IsUnspecified() {
			return ResolveResult{}, engineError(CodeAddressDenied, "hostname cannot be an unspecified address", http.StatusForbidden)
		}
		return ResolveResult{Hostname: canon, Addresses: []net.IP{ip}, DialIP: ip}, nil
	}
	if resolver == nil {
		resolver = SystemResolver{}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ips, err := resolver.LookupIP(ctx, "ip", canon)
	if err != nil {
		return ResolveResult{}, engineError(CodeAddressDenied, "hostname could not be resolved through the approved resolver", http.StatusForbidden)
	}
	seen := map[string]struct{}{}
	out := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if ip == nil || ip.IsUnspecified() {
			return ResolveResult{}, engineError(CodeAddressDenied, "resolver returned an unspecified address", http.StatusForbidden)
		}
		key := ip.String()
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, ip)
	}
	if len(out) == 0 {
		return ResolveResult{}, engineError(CodeAddressDenied, "hostname resolved to no usable addresses", http.StatusForbidden)
	}
	return ResolveResult{Hostname: canon, Addresses: out, DialIP: out[0]}, nil
}

// VerifyResolvedAddresses fail-closes unless every resolved IP is allowlisted.
// A DNS name without an allowlist is denied (anti DNS-rebinding / SSRF).
// An IP literal without an allowlist may connect only to that exact address.
func VerifyResolvedAddresses(host string, resolved []net.IP, allowlist []string, allowlistPresent bool) *EngineError {
	if len(resolved) == 0 {
		return engineError(CodeAddressDenied, "hostname resolved to no usable addresses", http.StatusForbidden)
	}
	if !allowlistPresent {
		if ip := net.ParseIP(strings.TrimSpace(host)); ip != nil {
			if len(resolved) != 1 || !ip.Equal(resolved[0]) {
				return engineError(CodeAddressDenied, "IP literal must connect only to itself", http.StatusForbidden)
			}
			return nil
		}
		return engineError(CodeAddressDenied, "DNS targets require allowedAddresses; every resolved address must be allowlisted", http.StatusForbidden)
	}
	if len(allowlist) == 0 {
		return engineError(CodeEmptyAllowlist, "A present address allowlist was empty (fail closed).", http.StatusBadRequest)
	}
	for _, ip := range resolved {
		if !AddressAllowed(allowlist, ip) {
			return engineError(CodeAddressDenied, "a resolved address is not on the target or policy allowlist", http.StatusForbidden)
		}
	}
	return nil
}

// AddressAllowed reports whether ip matches an IP or CIDR allowlist member.
func AddressAllowed(allowlist []string, ip net.IP) bool {
	if ip == nil || len(allowlist) == 0 {
		return false
	}
	for _, item := range allowlist {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if parsed := net.ParseIP(item); parsed != nil && parsed.Equal(ip) {
			return true
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// DialNetworkAddress is ip:port for the verified address only.
func DialNetworkAddress(ip net.IP, port int) string {
	if ip == nil || port < 1 {
		return ""
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(port))
}
