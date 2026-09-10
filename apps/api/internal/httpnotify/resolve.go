package httpnotify

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

// ResolveResult is a verified set of destination addresses.
type ResolveResult struct {
	Hostname  string
	Addresses []net.IP
	DialIP    net.IP
}

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
	if strings.ContainsAny(host, "/:@ ") || strings.Contains(host, "..") {
		return "", wrapInvalid("hostname is not a valid host or IP")
	}
	for _, r := range host {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '.'
		if !ok {
			return "", wrapInvalid("hostname is not a valid host or IP")
		}
	}
	if host[0] == '-' || host[len(host)-1] == '-' || host[0] == '.' {
		return "", wrapInvalid("hostname is not a valid host or IP")
	}
	return strings.ToLower(host), nil
}

// ResolveHostname looks up host through resolver. IP literals skip DNS.
// Every resolved address is checked after lookup (anti DNS-rebinding).
func ResolveHostname(ctx context.Context, resolver Resolver, host string, allowPrivate bool) (ResolveResult, *EngineError) {
	host = strings.TrimSpace(host)
	if host == "" {
		return ResolveResult{}, engineError(CodeInvalidEndpoint, "hostname is required", http.StatusBadRequest)
	}
	canon, err := NormalizeHostname(host)
	if err != nil {
		return ResolveResult{}, engineError(CodeInvalidEndpoint, "hostname is not a valid host or IP", http.StatusBadRequest)
	}
	if ip := net.ParseIP(canon); ip != nil {
		if denied, why := ssrfReason(ip, allowPrivate); denied {
			return ResolveResult{}, engineError(CodeSSRFDenied, why, http.StatusForbidden)
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
		if denied, why := ssrfReason(ip, allowPrivate); denied {
			return ResolveResult{}, engineError(CodeSSRFDenied, why, http.StatusForbidden)
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
// Link-local and metadata addresses are always denied, even if listed.
// Loopback, RFC1918, and ULA are denied unless allowPrivate is explicitly true.
func VerifyResolvedAddresses(host string, resolved []net.IP, allowlist []string, allowlistPresent bool, allowPrivate bool) *EngineError {
	if len(resolved) == 0 {
		return engineError(CodeAddressDenied, "hostname resolved to no usable addresses", http.StatusForbidden)
	}
	for _, ip := range resolved {
		if denied, why := ssrfReason(ip, allowPrivate); denied {
			return engineError(CodeSSRFDenied, why, http.StatusForbidden)
		}
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
			return engineError(CodeAddressDenied, "a resolved address is not on the destination-IP allowlist", http.StatusForbidden)
		}
	}
	return nil
}

// AddressOrNetworkCovered reports whether a connection IP or CIDR is contained
// by a policy allowlist of IPs/CIDRs. A tighter connection range (for example
// 203.0.113.0/25) is allowed when the policy lists a covering network
// (203.0.113.0/24). Hostnames fall back to case-insensitive equality.
func AddressOrNetworkCovered(allowlist []string, item string) bool {
	item = strings.TrimSpace(item)
	if item == "" || len(allowlist) == 0 {
		return false
	}
	if ip := net.ParseIP(item); ip != nil {
		return AddressAllowed(allowlist, ip)
	}
	if _, child, err := net.ParseCIDR(item); err == nil && child != nil {
		for _, parent := range allowlist {
			if networkCovers(parent, child) {
				return true
			}
		}
		return false
	}
	for _, parent := range allowlist {
		if strings.EqualFold(strings.TrimSpace(parent), item) {
			return true
		}
	}
	return false
}

func networkCovers(parent string, child *net.IPNet) bool {
	parent = strings.TrimSpace(parent)
	if child == nil || parent == "" {
		return false
	}
	if ip := net.ParseIP(parent); ip != nil {
		ones, bits := child.Mask.Size()
		return ones == bits && child.Contains(ip)
	}
	_, pnet, err := net.ParseCIDR(parent)
	if err != nil || pnet == nil {
		return false
	}
	pOnes, pBits := pnet.Mask.Size()
	cOnes, cBits := child.Mask.Size()
	if pBits != cBits || cOnes < pOnes {
		return false
	}
	return pnet.Contains(child.IP)
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

func parseIP(s string) net.IP {
	return net.ParseIP(strings.TrimSpace(s))
}

func ssrfReason(ip net.IP, allowPrivate bool) (bool, string) {
	if ip == nil {
		return true, "destination address is unusable"
	}
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return true, "destination address is unspecified or multicast"
	}
	if isLinkLocalOrMetadata(ip) {
		return true, "link-local and metadata addresses are denied"
	}
	if !allowPrivate && isPrivateOrLoopback(ip) {
		return true, "destination resolved to a non-public address"
	}
	return false, ""
}

// ipv6IMDS is AWS instance metadata over IPv6 (ULA, not link-local).
var ipv6IMDS = net.ParseIP("fd00:ec2::254")

func isLinkLocalOrMetadata(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	// AWS IPv6 IMDS is Unique Local (fd00::/8), so the private opt-in
	// must not open it. Same address the script egress policy denies.
	return ipv6IMDS != nil && ipv6IMDS.Equal(ip)
}

// isPrivateOrLoopback reports loopback, RFC1918, IPv6 ULA, and CGNAT.
// Link-local / metadata are handled separately and stay always-denied.
func isPrivateOrLoopback(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// RFC 6598 shared address space (CGNAT) 100.64.0.0/10
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
	}
	return false
}

func addressStrings(ips []net.IP) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		if ip != nil {
			out = append(out, ip.String())
		}
	}
	return out
}
