package embed

import "time"

// ADV-017: nbf clock-skew only. JWT libraries often allow "a few minutes";
// embed assertions are 15s–5m, so early-use of a not-yet-valid token must
// stay inside a short documented bound. exp is checked separately with
// no leeway — this helper must not be reused for expiry.
const (
	DefaultNBFLeeway = 30 * time.Second
	MaxNBFLeeway     = 60 * time.Second

	EnvNBFLeeway = "EMBED_NBF_LEEWAY"
)

// NormalizeNBFLeeway applies the documented default and hard max cap.
// Zero/negative (unset) becomes DefaultNBFLeeway. Values above
// MaxNBFLeeway are clamped — ops cannot loosen nbf past 60s.
func NormalizeNBFLeeway(in time.Duration) time.Duration {
	if in <= 0 {
		return DefaultNBFLeeway
	}
	if in > MaxNBFLeeway {
		return MaxNBFLeeway
	}
	return in
}

// LoadNBFLeeway reads EMBED_NBF_LEEWAY. Invalid or empty values use the
// documented default. Values above MaxNBFLeeway are clamped.
func LoadNBFLeeway() time.Duration {
	return NormalizeNBFLeeway(durationEnv(EnvNBFLeeway, 0))
}

// nbfNotYetValid reports whether nbf is in the future beyond leeway.
// leeway is normalized (default 30s, hard max 60s). Inclusive at the
// bound: nbf == now+leeway is accepted.
func nbfNotYetValid(now time.Time, nbfUnix int64, leeway time.Duration) bool {
	leeway = NormalizeNBFLeeway(leeway)
	nbf := time.Unix(nbfUnix, 0).UTC()
	return now.UTC().Add(leeway).Before(nbf)
}
